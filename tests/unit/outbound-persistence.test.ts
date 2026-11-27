// 코사장 11/27 광고성 전화 기록 영구화 어댑터·원장 계약(OPA1~OPA8). 가짜 트랜잭션만 — DB 판정 자체는 db/tests/99_outbound_persistence.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallContext, Target } from '../../src/server/outbound/compliance';
import { ClosedMockDialer, ClosedMockDnc, ClosedMockLedger, ClosedMockSuppressionStore, OutboundError, placeOutboundCall, selectSuppressionStore } from '../../src/server/outbound/providers';
import { DbOutboundLedger, DbSuppressionStore, type OutboundTx } from '../../src/server/outbound/db';

const H = (c: string) => c.repeat(64);
const NOON = new Date('2026-11-27T03:00:00Z');
const fakeTx = (respond: (q: string, v: unknown[]) => unknown) => {
  const log: { q: string; v: unknown[] }[] = [];
  const tx: OutboundTx = async (fn) => fn((async (s: TemplateStringsArray, ...v: unknown[]) => {
    const q = s.join('?'); log.push({ q, v }); const r = respond(q, v); if (r instanceof Error) throw r; return r as unknown[];
  }) as never);
  return { tx, log };
};
const target = (o: Partial<Target> = {}): Target => ({ phoneHmac: H('a'), source: { kind: 'customer_inquiry', recordId: 'lead-1', lawfulVerified: true, label: '상담 신청' }, adConsent: null, attempts: 0, lastAttemptAt: null, ...o });
const base: Omit<CallContext, 'dnc' | 'suppression' | 'now'> = {
  mode: 'live_agent', dialer: 'manual', purposeId: 'ad-internet-tv', businessId: 'bareun365',
  seller: { telemarketingRegistered: true, registrationNo: '제2026-0001호' }, disclosure: { businessName: '바른365', purpose: '안내', announcesSource: true },
  callerIdShown: true, businessNameShown: true, humanAgentReady: true, agentReserved: null,
};
const deps = (o: Record<string, unknown> = {}) => ({ dnc: new ClosedMockDnc({ [H('a')]: 'clear' }), suppression: new ClosedMockSuppressionStore(), dialer: new ClosedMockDialer(), ledger: new ClosedMockLedger(), clock: () => NOON, ...o });

test('OPA1 DB 수신거부 조회: clear/blocked만 그대로, 오류·형태 불량·빈 결과는 error(clear로 보지 않음)', async () => {
  const ok = fakeTx(() => [{ result: 'blocked', checked_at: NOON }]);
  assert.deepEqual(await new DbSuppressionStore(ok.tx, 'bareun365').check(H('a')), { result: 'blocked', checkedAt: NOON });
  assert.deepEqual(ok.log[0].v, ['bareun365', H('a')], '값은 바인딩만');
  for (const r of [new Error('db down'), [], [{ result: 'maybe', checked_at: NOON }], [{ result: 'clear', checked_at: 'x' }], [{ result: 'clear' }, { result: 'clear' }], null]) {
    const s = await new DbSuppressionStore(fakeTx(() => r).tx, 'bareun365').check(H('a'));
    assert.equal(s.result, 'error', JSON.stringify(r));
  }
  assert.equal((await new DbSuppressionStore(fakeTx(() => []).tx, 'bareun365').check('01012345678')).result, 'unknown');
  assert.throws(() => new DbSuppressionStore(fakeTx(() => []).tx, 'Bad Biz'), /INVALID_INPUT/);
});

test('OPA2 DB 수신거부 기록: blocked 응답만 성공, 그 밖은 LEDGER_FAILED', async () => {
  await new DbSuppressionStore(fakeTx(() => [{ r: 'blocked' }]).tx, 'bareun365').block(H('a'));
  await assert.rejects(new DbSuppressionStore(fakeTx(() => new Error('x')).tx, 'bareun365').block(H('a')), (e: unknown) => e instanceof OutboundError && e.code === 'LEDGER_FAILED');
  await assert.rejects(new DbSuppressionStore(fakeTx(() => [{ r: 'ok' }]).tx, 'bareun365').block(H('a')), /LEDGER_FAILED/);
  await assert.rejects(new DbSuppressionStore(fakeTx(() => []).tx, 'bareun365').block('010-1234-5678'), /INVALID_INPUT/);
});

test('OPA3 DB 원장: 시도 거부 사유(3회·24시간·수신거부)는 코드 그대로, 그 밖 DB 오류는 LEDGER_FAILED(원문 없음)', async () => {
  const err = (m: string, code = '22023') => Object.assign(new Error(m), { code });
  const e = { businessId: 'bareun365', phoneHmac: H('a'), purposeId: 'ad-internet-tv', mode: 'live_agent' as const, dialer: 'manual' as const };
  for (const m of ['RETRY_LIMIT', 'RETRY_TOO_SOON', 'OPTED_OUT']) await assert.rejects(new DbOutboundLedger(fakeTx(() => err(m)).tx).beginAttempt(e), (x: unknown) => x instanceof OutboundError && x.code === m);
  await assert.rejects(new DbOutboundLedger(fakeTx(() => err('connection to db.internal failed', '08006')).tx).beginAttempt(e), (x: unknown) => x instanceof OutboundError && x.code === 'LEDGER_FAILED');
  assert.equal(await new DbOutboundLedger(fakeTx(() => [{ id: '7' }]).tx).beginAttempt(e), 7);
  await assert.rejects(new DbOutboundLedger(fakeTx(() => [{ id: 0 }]).tx).beginAttempt(e), /LEDGER_FAILED/);
  const d = fakeTx(() => [{ id: 3 }]);
  await new DbOutboundLedger(d.tx).recordDecision({ businessId: 'bareun365', phoneHmac: H('a'), allowed: false, basis: null, reasons: ['NIGHT_BLOCKED'] });
  assert.equal(JSON.stringify(d.log).includes('바른365'), false, '고지문·상호 문구를 보내지 않음');
});

test('OPA4 판정 기록 실패 → 발신 0회(허용 판정이어도)', async () => {
  const dialer = new ClosedMockDialer();
  const r = await placeOutboundCall(deps({ dialer, ledger: new ClosedMockLedger({ decision: true }) }), target(), base);
  assert.equal(r.decision.allowed, true); assert.equal(r.callId, null); assert.equal(r.error, 'LEDGER_FAILED'); assert.equal(dialer.placed.length, 0);
});

test('OPA5 시도 시작 거부(DB의 3회·24시간·수신거부)·실패 → 발신 0회', async () => {
  for (const [code, err] of [['RETRY_LIMIT', 'ATTEMPT_REJECTED'], ['RETRY_TOO_SOON', 'ATTEMPT_REJECTED'], ['OPTED_OUT', 'ATTEMPT_REJECTED'], ['LEDGER_FAILED', 'LEDGER_FAILED']] as const) {
    const dialer = new ClosedMockDialer();
    const r = await placeOutboundCall(deps({ dialer, ledger: new ClosedMockLedger({ begin: code }) }), target({ attempts: 0 }), base);
    assert.equal(r.callId, null); assert.equal(r.error, err); assert.equal(dialer.placed.length, 0, code);
  }
});

test('OPA6 허용·차단 판정 모두 기록, 성공 시 시도 결과 placed, 결과 기록 실패는 알림', async () => {
  const ledger = new ClosedMockLedger(); const dialer = new ClosedMockDialer();
  const ok = await placeOutboundCall(deps({ ledger, dialer }), target(), base);
  assert.equal(ok.callId, 'mock-1'); assert.equal(ledger.attempts[0].result, 'placed');
  await placeOutboundCall(deps({ ledger, dialer, dnc: new ClosedMockDnc({}) }), target(), base);
  assert.deepEqual(ledger.decisions.map((d) => d.allowed), [true, false]);
  assert.equal(JSON.stringify(ledger.decisions).match(/01[016789]\d{7,8}/), null);
  const f = await placeOutboundCall(deps({ ledger: new ClosedMockLedger({ finish: true }) }), target(), base);
  assert.equal(f.callId, 'mock-1'); assert.equal(f.error, 'LEDGER_FINISH_FAILED');
});

test('OPA7 DB 장애(조회 실패)면 발신 0회 — DB 수신거부 어댑터를 오케스트레이터에 연결', async () => {
  const dialer = new ClosedMockDialer();
  const down = new DbSuppressionStore(fakeTx(() => new Error('db down')).tx, 'bareun365');
  const r = await placeOutboundCall(deps({ dialer, suppression: down }), target(), base);
  assert.ok(r.decision.reasons.includes('SUPPRESSION_UNCONFIRMED')); assert.equal(dialer.placed.length, 0);
  const noLedger = await placeOutboundCall({ ...deps(), ledger: undefined } as never, target(), base);
  assert.deepEqual(noLedger.decision.reasons, ['INVALID_INPUT'], '원장 없으면 발신 경로 자체가 닫힘');
});

test('OPA8 선택 함수는 여전히 Mock만: db·live 선택은 LIVE_OUTBOUND_NOT_APPROVED(연결은 승인 뒤)', () => {
  for (const m of ['db', 'live']) assert.throws(() => selectSuppressionStore({ OUTBOUND_SUPPRESSION_MODE: m }), (e: unknown) => e instanceof OutboundError && e.code === 'LIVE_OUTBOUND_NOT_APPROVED');
  assert.equal(new DbSuppressionStore(fakeTx(() => []).tx, 'bareun365').persistent, true);
});
