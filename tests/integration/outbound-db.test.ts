// 코사장 11/27 광고성 전화 서버 조립 ↔ 실제 로컬 PostgreSQL(0070 + zz_grants 적용된 가상 DB). app_call 역할 트랜잭션으로만 접근.
// 실제 발신·외부 호출 없음(발신기·두낫콜은 닫힌 Mock). HMAC은 가상 값.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { withRoleOn } from '../../src/server/db/client';
import { createOutboundService, outboundDbReady } from '../../src/server/outbound/assemble';
import { DbSuppressionStore, type OutboundSql, type OutboundTx } from '../../src/server/outbound/db';
import type { CallContext, Target } from '../../src/server/outbound/compliance';

const SOCK = process.env.FIDEON_TEST_PGSOCK ?? '/tmp';
const PORT = Number(process.env.FIDEON_TEST_PGPORT ?? 54329);
const DB = process.env.FIDEON_TEST_PGDATABASE ?? 'fideon_test';
const conn = (user: string) => postgres({ path: `${SOCK}/.s.PGSQL.${PORT}`, user, database: DB, prepare: false, max: 2, connect_timeout: 3, onnotice: () => {} });
const app = conn('app_server');
const app2 = conn('app_server');
const admin = conn('postgres');
after(async () => { await app.end(); await app2.end(); await admin.end(); });

const txOn = (sql: postgres.Sql): OutboundTx => (fn) => withRoleOn(sql, 'call', (t) => fn(t as unknown as OutboundSql));
const H = (c: string) => c.repeat(64 / c.length); // 64자 hex
const ENV = { OUTBOUND_PERSISTENCE: 'db' };
const base: Omit<CallContext, 'dnc' | 'suppression' | 'now'> = {
  mode: 'live_agent', dialer: 'manual', purposeId: 'ad-internet-tv', businessId: 'bareun365',
  seller: { telemarketingRegistered: true, registrationNo: '제2026-0001호' }, disclosure: { businessName: '바른365', purpose: '인터넷 안내', announcesSource: true },
  callerIdShown: true, businessNameShown: true, humanAgentReady: true, agentReserved: null,
};
const target = (h: string): Target => ({ phoneHmac: h, source: { kind: 'customer_inquiry', recordId: 'lead-ob', lawfulVerified: true, label: '상담 신청' }, adConsent: null, attempts: 0, lastAttemptAt: null });
const kstHour = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).getUTCHours();

test('OBI1 app_call로 0070 함수 6개 실행 준비 확인, 공개 역할로는 준비 안 됨', async () => {
  assert.equal(await outboundDbReady(txOn(app)), true);
  const asPublic: OutboundTx = (fn) => withRoleOn(app, 'public', (t) => fn(t as unknown as OutboundSql));
  assert.equal(await outboundDbReady(asPublic), false);
});

test('OBI2 수신거부: 서버 서비스 연결로 기록 → 다른 연결(새 세션)에서도 blocked, 타 사업자는 clear', async () => {
  const h = H('8c');
  await new DbSuppressionStore(txOn(app), 'bareun365').block(h);
  const again = await new DbSuppressionStore(txOn(app2), 'bareun365').check(h);
  assert.equal(again.result, 'blocked');
  assert.equal((await new DbSuppressionStore(txOn(app2), 'other-dealer').check(h)).result, 'clear');
  const svc = createOutboundService(ENV, { businessId: 'bareun365', tx: txOn(app), mockDncTable: { [h]: 'clear' } });
  const r = await svc.place(target(h), base);
  assert.equal(r.callId, null); assert.ok(r.decision.reasons.includes('OPTED_OUT'));
  const [{ n }] = await admin`select count(*)::int as n from core.outbound_decisions where phone_hmac = ${h} and not allowed and 'OPTED_OUT' = any(reasons)`;
  assert.equal(n, 1, '차단 판정 기록');
});

test('OBI3 허용 흐름: 판정·시도·결과 기록(발신 가능 시간), 밤이면 NIGHT_BLOCKED 기록·발신 0', async () => {
  const h = H('9d');
  const svc = createOutboundService(ENV, { businessId: 'bareun365', tx: txOn(app), mockDncTable: { [h]: 'clear' } });
  const r = await svc.place(target(h), base);
  const hour = kstHour(new Date());
  const dec = await admin`select allowed, basis, reasons from core.outbound_decisions where phone_hmac = ${h} order by id`;
  if (hour >= 8 && hour < 21 && r.decision.allowed) {
    assert.equal(r.callId, 'mock-1');
    assert.deepEqual(dec.map((d) => d.allowed), [true]);
    const att = await admin`select a.purpose_id, a.mode, r.result from core.outbound_attempts a join core.outbound_attempt_results r on r.attempt_id = a.id where a.phone_hmac = ${h}`;
    assert.deepEqual(att.map((x) => [x.purpose_id, x.mode, x.result]), [['ad-internet-tv', 'live_agent', 'placed']]);
    const second = await svc.place(target(h), base);
    assert.equal(second.callId, null); assert.ok(second.decision.reasons.includes('RETRY_TOO_SOON'), 'DB가 24시간 간격 강제(앱 숫자 0이어도)');
  } else {
    assert.equal(r.callId, null); assert.ok(r.decision.reasons.includes('NIGHT_BLOCKED'));
    assert.deepEqual(dec.map((d) => d.allowed), [false]);
  }
});

test('OBI4 DB 장애·잘못된 사업자·DB 미준비면 발신 0회', async () => {
  const h = H('ae');
  const broken: OutboundTx = async () => { throw new Error('connection refused'); };
  for (const svc of [
    createOutboundService(ENV, { businessId: 'bareun365', tx: broken, mockDncTable: { [h]: 'clear' } }),
    createOutboundService(ENV, { businessId: 'Bad Biz', tx: txOn(app), mockDncTable: { [h]: 'clear' } }),
    createOutboundService(ENV, { businessId: 'bareun365', tx: (fn) => withRoleOn(app, 'public', (t) => fn(t as unknown as OutboundSql)), mockDncTable: { [h]: 'clear' } }),
  ]) {
    const r = await svc.place(target(h), base);
    assert.equal(r.callId, null); assert.equal(r.decision.allowed, false);
  }
  const [{ n }] = await admin`select count(*)::int as n from core.outbound_attempts where phone_hmac = ${h}`;
  assert.equal(n, 0, '시도 기록 0건');
});

test('OBI5 직접 표 접근 거부(app_call)·기록 전체에 전화번호 원문 없음', async () => {
  await assert.rejects(withRoleOn(app, 'call', (t) => t`select * from core.outbound_suppressions`), /permission denied/);
  const [{ n }] = await admin`select count(*)::int as n from (
      select business_id || phone_hmac as x from core.outbound_suppressions
      union all select business_id || phone_hmac || coalesce(basis, '') || array_to_string(reasons, ',') from core.outbound_decisions
      union all select business_id || phone_hmac || purpose_id || mode || dialer from core.outbound_attempts) q
    where x ~ '01[016789][0-9]{7,8}' or x ~ '[가-힣]'`;
  assert.equal(n, 0);
});
