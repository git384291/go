// 총판 확인 집계 원장(PM 7043167591) — 가상 접수 10건·중복 재전송·미확인·한국시간 경계·두 총판 합산 중복 제거 종단 시험. 전부 가상(MOCK), 실적 아님.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REHEARSAL_ACKS, REHEARSAL_HANDOFFS, REHEARSAL_LEADS } from '../../src/mock/dealerRehearsal';
import { buildLedger, kstDay, type AckRecord, type HandoffRecord, type LeadRecord } from '../../src/content/dealerLedger';

const kst = (s: string) => Date.parse(`${s}+09:00`);
const lead = (n: number, customerKey = `c${n}`, consent = true): LeadRecord => ({ leadId: `L${n}`, customerKey, consentAt: consent ? kst('2026-11-22T09:00:00') : null, origin: 'MOCK' });
const ho = (n: number, dealer: 'dealer_a' | 'dealer_b' = 'dealer_a', at = '2026-11-22T10:00:00'): HandoffRecord => ({ leadId: `L${n}`, dealer, sentAt: kst(at) });
const ack = (e: string, n: number, at: string, dealer: 'dealer_a' | 'dealer_b' = 'dealer_a'): AckRecord => ({ eventId: e, leadId: `L${n}`, dealer, at: kst(at), evidence: 'dealer_ack_fixture' });
const leads = REHEARSAL_LEADS, handoffs = REHEARSAL_HANDOFFS, acks = REHEARSAL_ACKS;

test('DL1 종단: 가상 10건 → 확인된 고객만 한국시간 일자별 집계(두 총판·재접수 중복 제거)', () => {
  const r = buildLedger(leads, handoffs, acks);
  // 확인: L1, L2, L3(두 총판=1명), same(L4+L5=1명), L6 → 5명
  assert.deepEqual(r.total, { mock: 5, real: 0 });
  assert.deepEqual(r.byDay, { '2026-11-22': { mock: 4, real: 0 }, '2026-11-23': { mock: 1, real: 0 } });
  const by = Object.fromEntries(r.confirmed.map((c) => [c.customerKey, c]));
  assert.equal(by.c1!.day, '2026-11-23'); assert.equal(by.c2!.day, '2026-11-22');
  assert.deepEqual(by.c3!.dealers, ['dealer_a', 'dealer_b']); assert.equal(by.c3!.day, '2026-11-22', '가장 이른 확인(22일 15시) 기준');
  assert.deepEqual(by.same!.leadIds, ['L4', 'L5']); assert.equal(by.same!.day, '2026-11-22');
  assert.ok(r.confirmed.every((c) => c.origin === 'MOCK'));
});

test('DL2 미확인은 세지 않고 사유를 남김: 확인 없음·동의 없음·인계 없는 확인·인계 전 확인', () => {
  const r = buildLedger(leads, handoffs, acks);
  const u = Object.fromEntries(r.unconfirmed.map((x) => [x.leadId, x.reason]));
  assert.deepEqual(u, { L7: 'NO_CONSENT', L8: 'ACK_REJECTED', L9: 'ACK_REJECTED', L10: 'NO_ACK' });
  const reasons = r.ignored.map((i) => i.reason).sort();
  assert.deepEqual(reasons, ['ACK_BEFORE_HANDOFF', 'DUPLICATE_EVENT', 'DUPLICATE_HANDOFF', 'NO_HANDOFF']);
});

test('DL3 한국시간 하루 경계: 23:59:59.999와 00:00:00.000이 다른 날, UTC 날짜와 다름', () => {
  assert.equal(kstDay(kst('2026-11-22T23:59:59.999')), '2026-11-22');
  assert.equal(kstDay(kst('2026-11-23T00:00:00.000')), '2026-11-23');
  assert.equal(new Date(kst('2026-11-23T08:59:59.999')).toISOString().slice(0, 10), '2026-11-22', 'UTC로는 전날이어도 한국시간 23일');
  assert.equal(kstDay(kst('2026-11-23T08:59:59.999')), '2026-11-23');
});

test('DL4 모의와 실제 분리: 같은 고객키도 합치지 않고, 근거 종류가 출처와 다르면 거부', () => {
  const r = buildLedger([{ ...lead(1, 'x'), origin: 'MOCK' }, { leadId: 'R1', customerKey: 'x', consentAt: kst('2026-11-22T09:00:00'), origin: 'REAL' }],
    [ho(1), { leadId: 'R1', dealer: 'dealer_a', sentAt: kst('2026-11-22T10:00:00') }],
    [ack('m1', 1, '2026-11-22T11:00:00'), { eventId: 'r1', leadId: 'R1', dealer: 'dealer_a', at: kst('2026-11-22T11:00:00'), evidence: 'dealer_record_ref' }]);
  assert.deepEqual(r.total, { mock: 1, real: 1 });
  const bad = buildLedger([{ ...lead(1), origin: 'REAL' }], [ho(1)], [ack('f1', 1, '2026-11-22T11:00:00')]);
  assert.deepEqual(bad.total, { mock: 0, real: 0 }); assert.equal(bad.ignored[0]!.reason, 'EVIDENCE_MISMATCH');
  const bad2 = buildLedger([lead(1)], [ho(1)], [{ ...ack('f2', 1, '2026-11-22T11:00:00'), evidence: 'dealer_record_ref' }]);
  assert.deepEqual(bad2.total, { mock: 0, real: 0 });
});

test('DL5 확인 신호 없이 인계만으로는 0, 입력 없음·이상 입력은 던지지 않고 무시', () => {
  assert.deepEqual(buildLedger(leads, handoffs, []).total, { mock: 0, real: 0 });
  assert.deepEqual(buildLedger([], [], []).total, { mock: 0, real: 0 });
  const r = buildLedger([null, { leadId: '../x', customerKey: 'a', consentAt: 1, origin: 'MOCK' }] as never, [{ leadId: 'L1', dealer: 'x', sentAt: 1 }] as never, [undefined, { eventId: 'e', leadId: 'L1', dealer: 'dealer_a', at: -1, evidence: 'dealer_ack_fixture' }] as never);
  assert.deepEqual(r.total, { mock: 0, real: 0 }); assert.ok(r.ignored.length >= 4);
});

test('DL6 입력 불변·결과 동결·같은 입력은 같은 결과, 정적 검사(연결·시계·환경 없음)', () => {
  const snap = JSON.stringify([leads, handoffs, acks]);
  const a = buildLedger(leads, handoffs, acks), b = buildLedger([...leads].reverse(), [...handoffs].reverse(), [...acks].reverse());
  assert.equal(JSON.stringify([leads, handoffs, acks]), snap);
  assert.deepEqual(a.total, b.total); assert.deepEqual(a.byDay, b.byDay);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.total));
  const src = readFileSync('src/content/dealerLedger.ts', 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|fetch\(|console\.|setTimeout|setInterval|Date\.now|new Date\(\)|localStorage|import\s/.test(src));
});
