import { decryptRecording, RecordingError } from './recording';
import type { RecordingStore } from './recording';
import type { PiiCrypto, PiiKeys } from '../security/piiCrypto';
import { maskTranscript } from './transcriptMask';

/**
 * 녹취 자동 문자 변환(PM 11/25 ②).
 * - 실제 STT 업체 연동은 비용 발생 → PM 승인 전 금지. 지금은 Mock만 있고, 'live' 모드는 명시적으로 거부한다.
 * - 작업 1건 처리: DB가 한도 안에서 비용을 예약한 작업만 받는다 → 파일 복호화·해시 확인 → 변환 → 가림 → 원문 암호화 → 완료 기록.
 * - 실패: 일시 오류는 재시도(DB가 최대 3회·간격 증가), 파일 손상·해시 불일치 같은 영구 오류는 바로 dead.
 */
export type SttResult = { text: string; costKrw: number };

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, opts: { language: 'ko-KR'; durationSec: number }): Promise<SttResult>;
}

export class SttError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly chargedKrw = 0) { super(code); }
}

/** 시험용: 미리 정한 문장을 돌려준다. 외부 호출 없음, 비용 0원. */
export class MockSttProvider implements SttProvider {
  readonly name = 'mock_stt';
  calls = 0;
  constructor(private readonly script: (audio: Buffer) => string | SttError = () => '시험 변환문') {}
  async transcribe(audio: Buffer): Promise<SttResult> {
    this.calls += 1;
    const r = this.script(audio);
    if (r instanceof SttError) throw r;
    return { text: r, costKrw: 0 };
  }
}

/** 운영 STT 업체 선택. 승인 전에는 Mock 외 사용 불가(외부 비용 0 보장). */
export function selectSttProvider(env: Readonly<Record<string, string | undefined>> = process.env): SttProvider {
  const mode = env.CALL_STT_MODE ?? 'mock';
  if (mode === 'mock') return new MockSttProvider();
  throw new SttError('LIVE_STT_NOT_APPROVED', false);
}

export type SttClaim = { jobId: string; leaseToken: string; callId: string; storagePath: string; audioSha256: string; keyVersion: string; durationSec: number; reservedKrw: number };

export type SttDeps = {
  keys: PiiKeys;
  pii: PiiCrypto;
  store: RecordingStore;
  provider: SttProvider;
  claim: () => Promise<SttClaim | null>;
  complete: (c: SttClaim, transcriptEnc: string, transcriptMasked: string, provider: string, actualKrw: number) => Promise<string>;
  fail: (c: SttClaim, code: string, retryable: boolean, chargedKrw: number) => Promise<string>;
};

export async function runSttOnce(deps: SttDeps): Promise<{ result: string; jobId?: string }> {
  const c = await deps.claim();
  if (!c) return { result: 'idle' };
  let audio: Buffer;
  try {
    audio = decryptRecording(deps.keys, await deps.store.get(c.storagePath), c.keyVersion, c.audioSha256);
  } catch (e) {
    const code = e instanceof RecordingError ? e.message.replace(/[^A-Z0-9_]/g, '_').slice(0, 40) : 'STORE_ERROR';
    const permanent = e instanceof RecordingError && code !== 'NOT_FOUND';
    return { result: await deps.fail(c, code, !permanent, 0), jobId: c.jobId };
  }
  let r: SttResult;
  try {
    r = await deps.provider.transcribe(audio, { language: 'ko-KR', durationSec: c.durationSec });
  } catch (e) {
    if (e instanceof SttError) return { result: await deps.fail(c, e.code, e.retryable, e.chargedKrw), jobId: c.jobId };
    return { result: await deps.fail(c, 'PROVIDER_ERROR', true, c.reservedKrw), jobId: c.jobId }; // 청구 여부 모름 → 예약액으로 보수 기록
  }
  const text = r.text.trim();
  if (!text) return { result: await deps.fail(c, 'EMPTY_TRANSCRIPT', false, r.costKrw), jobId: c.jobId };
  const masked = maskTranscript(text).slice(0, 100_000);
  const result = await deps.complete(c, deps.pii.encrypt(text), masked, deps.provider.name, r.costKrw);
  return { result, jobId: c.jobId };
}
