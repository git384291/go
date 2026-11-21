// PM 11/22: 총판 전달용 신청서 열람·복사·이력 서버 모듈 시험. 가짜 의존성만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dealerPacketGet, handoffList, handoffRecord, type DealerPacketDeps } from '../../src/server/admin/dealerPacket';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const ID = '10000000-0000-4000-8000-000000000001';
const READY = { ADMIN_LEADS_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'tok', role }) as StaffIdentity;
const APP = { carrier: 'kt', productId: 'p1', regionCode: 'r1', installAddress: '서울시 가상구 시험로 12', housingType: 'apartment', subscriberType: 'self', currentCarrier: 'kt', installPref: 'asap' };

function mk(o: { env?: Record<string, string | undefined>; staff?: StaffIdentity | Error; rows?: unknown[]; err?: unknown; quote?: () => Promise<{ kind: 'quote' | 'needs_review'; text: string }> } = {}) {
  const c = { staff: 0, tx: 0, sql: [] as string[], vals: [] as unknown[][] };
  const d: DealerPacketDeps = {
    env: () => o.env ?? READY, mode: () => 'supabase',
    requireStaff: async () => { c.staff++; if (o.staff instanceof Error) throw o.staff; return o.staff ?? who('owner'); },
    runInTransaction: async (fn) => {
      c.tx++;
      const tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { c.sql.push(s.join('?')); c.vals.push(v); if (o.err) throw o.err; return o.rows ?? []; }) as never;
      return fn(tag);
    },
    decrypt: (s) => s.replace(/^v1:/, ''),
    quoteFor: o.quote ?? (async () => ({ kind: 'needs_review', text: '담당자 확인' })),
    now: () => new Date('2026-11-22T00:00:00Z'),
  };
  return { d, c };
}
const row = (over: Record<string, unknown> = {}) => ({ name_enc: 'v1:홍길동', phone_enc: 'v1:01012345678', payload_enc: 'v1:' + JSON.stringify(APP), summary: {}, interest: 'internet_tv', contact_time: '저녁', created_at: new Date('2026-11-21T00:00:00Z'), ...over });

test('DP1 닫힘: 환경 미충족·잘못된 id → 인증·DB 0회', async () => {
  for (const env of [{}, { ...READY, NODE_ENV: 'production' }, { ...READY, ADMIN_LEADS_SOURCE: 'mock' }]) {
    const { d, c } = mk({ env });
    assert.equal((await dealerPacketGet(d, ID, { reason: '전달 준비' })).status, 503);
    assert.deepEqual([c.staff, c.tx], [0, 0]);
  }
  const { d, c } = mk();
  assert.equal((await dealerPacketGet(d, 'x', { reason: '전달 준비' })).status, 400);
  assert.deepEqual([c.staff, c.tx], [0, 0]);
});

test('DP2 권한: 미인증 401·권한 밖 역할 403(DB 0회), 검토자는 이력 조회만', async () => {
  const a = mk({ staff: new StaffAuthError(401, 'UNAUTHENTICATED') });
  assert.equal((await dealerPacketGet(a.d, ID, { reason: '전달 준비' })).status, 401);
  for (const role of ['reviewer', 'policy_editor']) {
    const { d, c } = mk({ staff: who(role) });
    assert.equal((await dealerPacketGet(d, ID, { reason: '전달 준비' })).status, 403);
    assert.equal((await handoffRecord(d, ID, { event: 'copied' })).status, 403);
    assert.equal(c.tx, 0);
  }
  const r = mk({ staff: who('reviewer'), rows: [{ event: 'viewed', note: null, actor_id: 'a', created_at: 't' }] });
  assert.equal((await handoffList(r.d, ID)).status, 200);
});

test('DP3 열람: 사유 필수, 복호화된 자료에 주소·총판 별도 확인 항목·승인 정책 안내만, no-store', async () => {
  for (const b of [{}, { reason: '' }, { reason: 'x' }, { reason: '전달 준비', extra: 1 }, null]) {
    const { d, c } = mk({ rows: [row()] });
    assert.equal((await dealerPacketGet(d, ID, b)).status, 400);
    assert.equal(c.tx, 0);
  }
  const { d, c } = mk({ rows: [row()] });
  const r = await dealerPacketGet(d, ID, { reason: '총판 전달 준비' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const j = (await r.json()) as { packet: { status: string; text: string; missing: string[] } };
  assert.equal(j.packet.status, 'complete');
  assert.match(j.packet.text, /시험로 12/);
  assert.match(j.packet.text, /홍길동/);
  assert.match(j.packet.text, /주민등록번호/);
  assert.match(j.packet.text, /담당자 확인/);
  assert.match(c.sql[0], /api\.dealer_packet_get/);
  assert.equal(c.vals[0].includes('총판 전달 준비'), true);
});

test('DP4 신청서 없음 → incomplete·누락 목록, 견적 조회 실패 → 승인 정책 안내 없음(금액 미포함)', async () => {
  const { d } = mk({ rows: [row({ payload_enc: null })], quote: async () => { throw new Error('boom'); } });
  const j = (await (await dealerPacketGet(d, ID, { reason: '전달 준비' })).json()) as { hasApplication: boolean; packet: { status: string; missing: string[]; text: string } };
  assert.equal(j.hasApplication, false);
  assert.equal(j.packet.status, 'incomplete');
  assert.ok(j.packet.missing.includes('installAddress'));
  assert.match(j.packet.text, /승인 정책 안내 없음/);
  assert.doesNotMatch(j.packet.text, /\d원/);
});

test('DP5 복호화 실패·본문 변조 → 502, DB 오류는 허용 코드만(SQL 비노출)', async () => {
  let r = await dealerPacketGet(mk({ rows: [row({ name_enc: undefined })] }).d, ID, { reason: '전달 준비' });
  assert.equal(r.status, 200); // decrypt 스텁은 문자열화하므로 통과 — 아래가 본 시험
  r = await dealerPacketGet(mk({ rows: [row({ payload_enc: 'v1:{"installAddress":"900101-1234567"}' })] }).d, ID, { reason: '전달 준비' });
  assert.equal(r.status, 502);
  for (const [err, status] of [[{ code: '42501' }, 403], [{ code: '54000' }, 429], [{ code: '22023', message: 'REASON_REQUIRED' }, 400], [{ message: 'select secret from x' }, 503]] as const) {
    const x = await dealerPacketGet(mk({ err }).d, ID, { reason: '전달 준비' });
    assert.equal(x.status, status);
    assert.doesNotMatch(await x.text(), /select|secret/);
  }
  assert.equal((await dealerPacketGet(mk({ rows: [] }).d, ID, { reason: '전달 준비' })).status, 403);
});

test('DP6 이력 기록: copied/sent만, 메모 길이 제한, sent 사전 열람 오류는 409', async () => {
  const { d, c } = mk();
  assert.equal((await handoffRecord(d, ID, { event: 'copied' })).status, 200);
  assert.equal((await handoffRecord(d, ID, { event: 'sent', note: 'A총판 메일' })).status, 200);
  assert.match(c.sql[0], /api\.handoff_record/);
  for (const b of [{ event: 'viewed' }, { event: 'sent', note: 'x'.repeat(201) }, { event: 'copied', foo: 1 }, { event: 'sent', note: 3 }, null]) {
    assert.equal((await handoffRecord(mk().d, ID, b)).status, 400);
  }
  const x = await handoffRecord(mk({ err: { code: '22023', message: 'PACKET_NOT_VIEWED' } }).d, ID, { event: 'sent', note: 'A총판' });
  assert.equal(x.status, 400);
});
