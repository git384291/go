import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import type { PiiKeys } from '../../src/server/security/piiCrypto';
import { signToken } from '../../src/server/security/token';
import { decryptRecording, encryptRecording, MemoryRecordingStore, RecordingError, isRecordingPath } from '../../src/server/calls/recording';
import { hasUnmaskedPii, maskTranscript } from '../../src/server/calls/transcriptMask';
import { ingestCall } from '../../src/server/calls/ingest';
import type { CallIngestArgs } from '../../src/server/calls/ingest';
import { MockSttProvider, runSttOnce, selectSttProvider, SttError } from '../../src/server/calls/stt';
import type { SttClaim } from '../../src/server/calls/stt';
import { MockSummaryModel, runSummaryOnce, sanitizeSummary, selectSummaryModel } from '../../src/server/calls/summary';
import type { SummaryClaim, SummaryValue } from '../../src/server/calls/summary';

// 통화 녹취·STT·요약 서버 로직(PM 11/25 ①②③) — Mock만, 외부 호출·실제 고객 데이터 없음
const KEYS: PiiKeys = { encKeys: { '1': Buffer.alloc(32, 7) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 8), ipHashKey: Buffer.alloc(32, 9) };
const pii = createPiiCrypto(KEYS);
const AUDIO = Buffer.from('가상 음성 데이터'.repeat(10));
const NOW = 1_800_000_000;

test('CA1 녹취 암호화: 복호화 일치, 파일에 원문 없음', () => {
  const e = encryptRecording(KEYS, AUDIO);
  assert.equal(e.keyVersion, '1');
  assert.equal(e.audioBytes, AUDIO.length);
  assert.ok(!e.data.includes(AUDIO.subarray(0, 12)));
  assert.deepEqual(decryptRecording(KEYS, e.data, '1', e.audioSha256), AUDIO);
});

test('CA2 녹취 변조·해시 불일치·키 없음 거부', () => {
  const e = encryptRecording(KEYS, AUDIO);
  const bad = Buffer.from(e.data); bad[bad.length - 1] ^= 1;
  assert.throws(() => decryptRecording(KEYS, bad, '1', e.audioSha256), /RECORDING_TAMPERED/);
  assert.throws(() => decryptRecording(KEYS, e.data, '1', 'f'.repeat(64)), /RECORDING_HASH_MISMATCH/);
  assert.throws(() => decryptRecording(KEYS, e.data, '9', e.audioSha256), /KEY_VERSION_UNAVAILABLE/);
  assert.throws(() => encryptRecording(KEYS, Buffer.alloc(0)), RecordingError);
});

test('CA3 가림: 전화·주민번호·긴 숫자 제거, DB 검사와 같은 판정', () => {
  const m = maskTranscript('제 번호는 010-1234-5678 이고 주민번호 900101-1234567, 계좌 12345678 입니다');
  assert.ok(!hasUnmaskedPii(m), m);
  assert.ok(hasUnmaskedPii('공일공 010 1234 5678'));
  assert.ok(!hasUnmaskedPii('월 33,000원 3년 약정'));
});

test('CA4 통화 수신: 연락처 원문 대신 HMAC, 안내 재생 시에만 암호화 파일 저장, 서명 필드 순서 = DB', async () => {
  const store = new MemoryRecordingStore();
  const seen: { token: string; args: CallIngestArgs }[] = [];
  const sk = { keyId: 1, secret: Buffer.alloc(32, 0x22) };
  const deps = {
    pii, keys: KEYS, store,
    sign: (f: ReadonlyArray<string | null>) => signToken('lead', f, sk, NOW),
    ingest: async (token: string, args: CallIngestArgs) => { seen.push({ token, args }); return 'stored'; },
  };
  const base = { provider: 'mock_tel', providerCallId: 'call-0001', direction: 'inbound' as const, customerPhone: '010-1234-5678',
    startedEpoch: NOW - 60, durationSec: 90, noticeVersion: 'rec-notice-v1', audio: AUDIO, agentId: null };
  assert.equal(await ingestCall(deps, base), 'stored');
  const a = seen[0].args;
  assert.equal(a.phoneHmac, pii.phoneHmac('01012345678'));
  assert.ok(a.storagePath && isRecordingPath(a.storagePath));
  assert.ok(!JSON.stringify(a).includes('5678'));
  assert.equal(store.files.size, 1);
  assert.deepEqual(decryptRecording(KEYS, await store.get(a.storagePath!), a.keyVersion!, a.audioSha256!), AUDIO);
  const expected = signToken('lead', ['call-ingest', 'mock_tel', 'call-0001', 'inbound', a.phoneHmac, String(NOW - 60), '90',
    'rec-notice-v1', a.storagePath, a.audioSha256, String(a.audioBytes), '1', null], sk, NOW);
  assert.equal(seen[0].token, expected);
  // 안내 미재생: 음성을 저장소에 올리지 않음
  await ingestCall(deps, { ...base, providerCallId: 'call-0002', noticeVersion: null });
  assert.equal(seen[1].args.storagePath, null);
  assert.equal(store.files.size, 1);
  await assert.rejects(ingestCall(deps, { ...base, providerCallId: 'x' }), /INVALID_INPUT/);
});

function sttHarness(provider: MockSttProvider, data?: Buffer) {
  const store = new MemoryRecordingStore();
  const e = encryptRecording(KEYS, AUDIO);
  const path = 'calls/00000000-0000-4000-8000-000000000001.bin';
  void store.put(path, data ?? e.data);
  const claim: SttClaim = { jobId: '1', leaseToken: 't', callId: 'c', storagePath: path, audioSha256: e.audioSha256, keyVersion: '1', durationSec: 90, reservedKrw: 100 };
  const log: string[] = [];
  let given = false;
  return {
    log,
    deps: {
      keys: KEYS, pii, store, provider,
      claim: async () => {
        if (given) return null;
        given = true;
        return claim;
      },
      complete: async (_c: SttClaim, enc: string, masked: string) => { log.push(`complete:${enc.slice(0, 3)}:${masked}`); return 'done'; },
      fail: async (_c: SttClaim, code: string, retryable: boolean, charged: number) => { log.push(`fail:${code}:${retryable}:${charged}`); return retryable ? 'retry' : 'dead'; },
    },
  };
}

test('CA5 STT 성공: 원문 암호화·가린 글만 평문', async () => {
  const h = sttHarness(new MockSttProvider(() => '연락처 010-9999-8888 로 주세요'));
  assert.deepEqual(await runSttOnce(h.deps), { result: 'done', jobId: '1' });
  assert.equal(h.log[0], 'complete:v1::연락처 [전화] 로 주세요');
  assert.deepEqual(await runSttOnce(h.deps), { result: 'idle' });
});

test('CA6 STT 실패 분류: 일시 오류 재시도, 손상 파일·빈 결과는 바로 중단, 알 수 없는 오류는 예약액 기록', async () => {
  let h = sttHarness(new MockSttProvider(() => new SttError('PROVIDER_TIMEOUT', true)));
  assert.equal((await runSttOnce(h.deps)).result, 'retry');
  h = sttHarness(new MockSttProvider(), Buffer.from('FCR1broken-file-content-xxxxxxxxxxxxxx'));
  assert.equal((await runSttOnce(h.deps)).result, 'dead');
  assert.equal(h.log[0], 'fail:RECORDING_TAMPERED:false:0');
  h = sttHarness(new MockSttProvider(() => '   '));
  assert.equal((await runSttOnce(h.deps)).result, 'dead');
  const p = new MockSttProvider();
  p.transcribe = async () => { throw new Error('socket'); };
  h = sttHarness(p);
  await runSttOnce(h.deps);
  assert.equal(h.log[0], 'fail:PROVIDER_ERROR:true:100');
});

test('CA7 승인 전 실제 STT·AI 모델 사용 불가', () => {
  assert.equal(selectSttProvider({}).name, 'mock_stt');
  assert.throws(() => selectSttProvider({ CALL_STT_MODE: 'live' }), /LIVE_STT_NOT_APPROVED/);
  assert.throws(() => selectSummaryModel({ CALL_SUMMARY_MODE: 'live' }), /LIVE_SUMMARY_NOT_APPROVED/);
});

const T = '[이름] 고객: 인터넷 티비 같이 신청하고 싶어요. 내일 오후 3시에 다시 전화 주세요.';

test('CA8 추측 금지: 근거가 변환문에 없으면 unknown/null', () => {
  const v = sanitizeSummary({ summary: '인터넷+TV 희망', product: 'internet_tv', outcome: 'applied', callbackEpoch: NOW + 3600,
    evidence: { product: '인터넷 티비 같이 신청하고 싶어요', outcome: '가입 완료했어요', callback: '모레 다시' } }, T, NOW)!;
  assert.equal(v.product, 'internet_tv');
  assert.equal(v.outcome, 'unknown');
  assert.equal(v.callbackEpoch, null);
  assert.deepEqual(v.evidence, { product: '인터넷 티비 같이 신청하고 싶어요' });
  assert.equal(sanitizeSummary({ summary: '', product: 'internet_tv' }, T, NOW), null);
  assert.equal(sanitizeSummary('문자열', T, NOW), null);
  const w = sanitizeSummary({ summary: '모름', product: 'tv_plus', evidence: { product: '인터넷 티비' } }, T, NOW)!;
  assert.equal(w.product, 'unknown');
  const far = sanitizeSummary({ summary: 's1', callbackEpoch: NOW + 365 * 86400, evidence: { callback: '내일 오후 3시' } }, T, NOW)!;
  assert.equal(far.callbackEpoch, null);
  assert.equal(sanitizeSummary({ summary: '번호 010-1111-2222' }, T, NOW)!.summary, '번호 [전화]');
});

function sumHarness(opts: { hold?: string | null; job?: boolean; output?: unknown; throws?: boolean }) {
  const log: string[] = [];
  const model = new MockSummaryModel(() => opts.output ?? { summary: '요약' });
  if (opts.throws) model.summarize = async () => { throw new Error('x'); };
  const deps = {
    model, nowEpoch: () => NOW,
    aiHold: async (c: number) => { log.push(`hold:${c}`); return opts.hold === undefined ? 'r1' : opts.hold; },
    aiConfirm: async (r: string, a: number) => { log.push(`confirm:${r}:${a}`); return true; },
    aiRelease: async (r: string) => { log.push(`release:${r}`); return true; },
    claim: async () => (opts.job === false ? null : ({ jobId: '9', leaseToken: 'l', callId: 'c', transcriptMasked: T } as SummaryClaim)),
    complete: async (_c: SummaryClaim, v: SummaryValue) => { log.push(`complete:${v.product}:${v.outcome}`); return 'done'; },
    fail: async (_c: SummaryClaim, code: string) => { log.push(`fail:${code}`); return 'retry'; },
  };
  return { deps, log, model };
}

test('CA9 요약 비용: 한도 없으면 모델 호출 0, 작업 없으면 예약 취소, 실패 시 예약액 확정', async () => {
  let h = sumHarness({ hold: null });
  assert.equal((await runSummaryOnce(h.deps)).result, 'budget_blocked');
  assert.equal(h.model.calls, 0);
  h = sumHarness({ job: false });
  assert.equal((await runSummaryOnce(h.deps)).result, 'idle');
  assert.deepEqual(h.log, ['hold:20', 'release:r1']);
  h = sumHarness({ throws: true });
  assert.equal((await runSummaryOnce(h.deps)).result, 'retry');
  assert.deepEqual(h.log, ['hold:20', 'confirm:r1:20', 'fail:MODEL_ERROR']);
  h = sumHarness({ output: { summary: '인터넷+TV 희망', product: 'internet_tv', outcome: 'callback_requested', callbackEpoch: NOW + 86400,
    evidence: { product: '인터넷 티비', outcome: '다시 전화 주세요', callback: '내일 오후 3시' } } });
  assert.equal((await runSummaryOnce(h.deps)).result, 'done');
  assert.deepEqual(h.log, ['hold:20', 'confirm:r1:0', 'complete:internet_tv:callback_requested']);
});

test('CA8 저장 실패 처리: 업로드 실패 → DB 호출 없음, DB 실패 → 올린 파일 즉시 삭제, 삭제도 실패 → ORPHAN 경로 보고', async () => {
  const base = { provider: 'mock', providerCallId: 'call-f001', direction: 'inbound' as const, customerPhone: '010-1234-5678',
    startedEpoch: 1_764_000_000, durationSec: 60, noticeVersion: 'rec-v1', audio: AUDIO, agentId: null };
  let dbCalls = 0;
  const failPut = new MemoryRecordingStore();
  failPut.put = async () => { throw new Error('net'); };
  await assert.rejects(ingestCall({ pii, keys: KEYS, store: failPut, sign: () => 't', ingest: async () => { dbCalls++; return 'stored'; } }, base), /STORE_FAILED/);
  assert.equal(dbCalls, 0);
  const store = new MemoryRecordingStore();
  await assert.rejects(ingestCall({ pii, keys: KEYS, store, sign: () => 't', ingest: async () => { throw new Error('db down'); } }, base), /db down/);
  assert.equal(store.files.size, 0);
  const sticky = new MemoryRecordingStore();
  sticky.delete = async () => { throw new Error('net'); };
  await assert.rejects(ingestCall({ pii, keys: KEYS, store: sticky, sign: () => 't', ingest: async () => { throw new Error('db down'); } }, base), /ORPHAN_RECORDING:calls\/[0-9a-f-]{36}\.bin/);
});
