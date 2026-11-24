import { normalizeMobile } from '../security/piiCrypto';
import type { PiiCrypto, PiiKeys } from '../security/piiCrypto';
import { encryptRecording, newRecordingPath } from './recording';
import type { RecordingStore } from './recording';

/**
 * 통화 수신(PM 11/25 ①). 통신사 웹훅 검증(서명)은 연동 업체가 정해진 뒤 앞단에서 한다 — 실제 통신사 연동은 PM 승인 전 금지.
 * 흐름: 연락처 → HMAC(원문 저장 안 함) → 안내 재생 + 음성이 있으면 암호화해 저장소에 올림 → 서버 서명과 함께 DB api.call_ingest.
 * DB가 보관 여부를 최종 판정한다(녹취 꺼짐·안내 버전 불일치면 파일을 삭제 대기열로 보냄).
 */
export type CallIngestInput = {
  provider: string;
  providerCallId: string;
  direction: 'inbound' | 'outbound';
  customerPhone: string;
  startedEpoch: number;
  durationSec: number;
  noticeVersion: string | null; // 통화 시작 시 재생한 녹취 안내 버전. 재생 안 했으면 null
  audio: Buffer | null;
  agentId: string | null;
};

export type CallIngestArgs = {
  provider: string; providerCallId: string; direction: string; phoneHmac: string;
  startedEpoch: number; durationSec: number; noticeVersion: string | null;
  storagePath: string | null; audioSha256: string | null; audioBytes: number | null; keyVersion: string | null; agentId: string | null;
};

export type CallIngestDeps = {
  pii: PiiCrypto;
  keys: PiiKeys;
  store: RecordingStore;
  sign: (fields: ReadonlyArray<string | null>) => string; // 'lead' 목적 서버 서명
  ingest: (token: string, args: CallIngestArgs) => Promise<string>;
};

export class CallIngestError extends Error {}

export async function ingestCall(deps: CallIngestDeps, input: CallIngestInput): Promise<string> {
  if (!/^[a-z0-9_]{2,30}$/.test(input.provider) || !/^[A-Za-z0-9._:-]{4,128}$/.test(input.providerCallId)
      || (input.direction !== 'inbound' && input.direction !== 'outbound')
      || !Number.isSafeInteger(input.startedEpoch) || !Number.isInteger(input.durationSec) || input.durationSec < 0 || input.durationSec > 14_400
      || (input.noticeVersion !== null && !/^[A-Za-z0-9._-]{1,40}$/.test(input.noticeVersion))) {
    throw new CallIngestError('INVALID_INPUT');
  }
  const phoneHmac = deps.pii.phoneHmac(normalizeMobile(input.customerPhone));
  // 안내를 재생하지 않은 통화의 음성은 저장소에 올리지도 않는다
  const enc = input.audio && input.noticeVersion ? encryptRecording(deps.keys, input.audio) : null;
  const storagePath = enc ? newRecordingPath() : null;
  if (enc && storagePath) await deps.store.put(storagePath, enc.data);
  const args: CallIngestArgs = {
    provider: input.provider, providerCallId: input.providerCallId, direction: input.direction, phoneHmac,
    startedEpoch: input.startedEpoch, durationSec: input.durationSec, noticeVersion: input.noticeVersion,
    storagePath, audioSha256: enc?.audioSha256 ?? null, audioBytes: enc?.audioBytes ?? null, keyVersion: enc?.keyVersion ?? null,
    agentId: input.agentId,
  };
  const token = deps.sign(['call-ingest', args.provider, args.providerCallId, args.direction, args.phoneHmac,
    String(args.startedEpoch), String(args.durationSec), args.noticeVersion, args.storagePath, args.audioSha256,
    args.audioBytes === null ? null : String(args.audioBytes), args.keyVersion, args.agentId]);
  return deps.ingest(token, args);
}
