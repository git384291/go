// 통화 수신 서명·인자(TypeScript ingestCall)와 DB api.call_ingest 규칙이 같은지 확인하는 SQL을 출력한다(0050, PM 11/25 ①).
// scripts/db-test.sh가 psql로 실행. 가상 키·가상 연락처만, 외부 호출 없음.
import { signToken } from '../src/server/security/token';
import { createPiiCrypto } from '../src/server/security/piiCrypto';
import { ingestCall, type CallIngestArgs } from '../src/server/calls/ingest';
import { MemoryRecordingStore } from '../src/server/calls/recording';

const leadKey = { keyId: 1, secret: Buffer.alloc(32, 0x22) }; // 시드의 테스트 키와 동일
const keys = { encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: Buffer.alloc(32, 4) };
const q = (s: string | null) => (s === null ? 'null' : `'${s.replace(/'/g, "''")}'`);
const n = (v: number | null) => (v === null ? 'null' : String(v));

async function main() {
  const out: { token: string; a: CallIngestArgs }[] = [];
  const deps = {
    pii: createPiiCrypto(keys), keys, store: new MemoryRecordingStore(),
    sign: (f: ReadonlyArray<string | null>) => signToken('lead', f, leadKey),
    ingest: async (token: string, a: CallIngestArgs) => { out.push({ token, a }); return 'captured'; },
  };
  const now = Math.floor(Date.now() / 1000);
  await ingestCall(deps, { provider: 'mock_tel', providerCallId: 'parity-call-0001', direction: 'inbound', customerPhone: '010-0000-0098',
    startedEpoch: now - 120, durationSec: 61, noticeVersion: 'parity-notice-v1', audio: Buffer.from('parity audio'), agentId: null });
  const { token, a } = out[0];
  const call = (t: string) => `select api.call_ingest(${q(t)}, ${q(a.provider)}, ${q(a.providerCallId)}, ${q(a.direction)}, ${q(a.phoneHmac)}, ${a.startedEpoch}::bigint, ${a.durationSec}, ${q(a.noticeVersion)}, ${q(a.storagePath)}, ${q(a.audioSha256)}, ${n(a.audioBytes)}::int, ${q(a.keyVersion)}, null::uuid)`;
  console.log(`update core.call_settings set recording_enabled = true, notice_version = 'parity-notice-v1';`);
  console.log('set role app_call;');
  console.log(`select test.expect_eq($$${call(token)}$$, 'stored', 'S7 TS가 만든 통화 수신(서명·인자)이 작업자 역할로 저장됨');`);
  console.log(`select test.expect_eq($$${call(token)}$$, 'exists', 'S8 같은 통화 재전송은 exists');`);
  console.log('reset role;');
  console.log(`select test.expect_eq($$select count(*)::text from core.call_jobs j join core.calls c on c.id = j.call_id where c.provider_call_id = 'parity-call-0001' and j.kind = 'stt'$$, '1', 'S9 변환 작업 1건 자동 등록');`);
  console.log(`update core.call_settings set recording_enabled = false;`);
}
void main();
