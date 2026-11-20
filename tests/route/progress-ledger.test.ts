// 진행판 ↔ 총판 확인 원장 연결(PM 7043652741): 동의→인계→확인→진행판 표시까지 한 경로. 가상 연습(MOCK)과 실제 분리, 자료 없으면 실적 '미확인'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { ProgressView } from '../../src/app/admin/progress/ProgressView';
import { buildLedger, type AckRecord, type HandoffRecord, type LeadRecord } from '../../src/content/dealerLedger';
import { composeProgressSnapshot, loadProgressSnapshot, REAL_DEALER_INPUT, REHEARSAL_INPUT } from '../../src/server/admin/progressLedger';
import { PROGRESS_SNAPSHOT } from '../../src/server/admin/progressSnapshot';

function strings(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const x of node) strings(x, out, seen); return out; }
  const el = node as { type?: unknown; props?: unknown };
  if ('props' in el && 'type' in el) { if (typeof el.type === 'function') strings((el.type as (p: unknown) => unknown)(el.props), out, seen); strings(el.props, out, seen); return out; }
  for (const v of Object.values(node)) strings(v, out, seen);
  return out;
}
const screen = (snap: ReturnType<typeof loadProgressSnapshot>) => strings(ProgressView({ snapshot: snap, now: new Date('2026-11-22T12:00:00+09:00') }) as ReactElement).join('');
const kst = (s: string) => Date.parse(`${s}+09:00`);

test('PL1 실제 자료 없음 → 실적 미확인(0건 아님), 가상 연습은 별도 칸·실적 아님 표기', () => {
  const snap = loadProgressSnapshot();
  assert.equal(snap.sales.value, null);
  const t = screen(snap);
  assert.match(t, /총판 확인 기준 실제 접수 실적: 미확인/);
  assert.ok(!/실적: \d+건/.test(t), '실적 칸에 숫자 없음');
  assert.ok(t.includes('가상 연습 집계 (실적 아님)') && t.includes('실제 접수나 영업 실적이 아닙니다'));
});

test('PL2 화면 수치 = 원장: 가상 10건 → 확인 5건, 일자별 11/22 4건·11/23 1건(한국시간 경계)', () => {
  const ledger = buildLedger(REHEARSAL_INPUT.leads, REHEARSAL_INPUT.handoffs, REHEARSAL_INPUT.acks);
  const snap = loadProgressSnapshot();
  assert.equal(snap.rehearsal?.total, ledger.total.mock); assert.equal(ledger.total.mock, 5);
  assert.deepEqual(snap.rehearsal?.byDay, [{ day: '2026-11-22', count: 4 }, { day: '2026-11-23', count: 1 }]);
  const t = screen(snap);
  assert.ok(t.includes('확인된 가상 접수: 5건') && t.includes('2026-11-22(한국시간): 4건') && t.includes('2026-11-23(한국시간): 1건'));
  assert.equal(ledger.total.real, 0);
});

test('PL3 실제 자료가 입력에 있을 때만 실적 숫자: 있으나 확인 0이면 0건, 가상 연습은 실적에 합치지 않음', () => {
  const real: LeadRecord[] = [{ leadId: 'R1', customerKey: 'r1', consentAt: kst('2026-11-23T09:00:00'), origin: 'REAL' }, { leadId: 'R2', customerKey: 'r2', consentAt: kst('2026-11-23T09:00:00'), origin: 'REAL' }];
  const hoR: HandoffRecord[] = [{ leadId: 'R1', dealer: 'dealer_a', sentAt: kst('2026-11-23T10:00:00') }, { leadId: 'R2', dealer: 'dealer_b', sentAt: kst('2026-11-23T10:00:00') }];
  const ackR: AckRecord[] = [{ eventId: 'ra', leadId: 'R1', dealer: 'dealer_a', at: kst('2026-11-23T11:00:00'), evidence: 'dealer_record_ref' }];
  const one = composeProgressSnapshot(PROGRESS_SNAPSHOT, { leads: real, handoffs: hoR, acks: ackR }, REHEARSAL_INPUT);
  assert.equal(one.sales.value, 1); assert.equal(one.rehearsal?.total, 5);
  assert.ok(screen(one).includes('실제 접수 실적: 1건'));
  const zero = composeProgressSnapshot(PROGRESS_SNAPSHOT, { leads: real, handoffs: hoR, acks: [] }, null);
  assert.equal(zero.sales.value, 0); assert.equal(zero.rehearsal, undefined);
  assert.equal(composeProgressSnapshot(PROGRESS_SNAPSHOT, REAL_DEALER_INPUT, null).sales.value, null);
});

test('PL4 실패 후 재시도: 총판 A 무응답→총판 B 재전송·확인 → 1건, 같은 총판 재전송·중복 이벤트는 늘리지 않음, 화면과 일치', () => {
  const leads: LeadRecord[] = [{ leadId: 'L1', customerKey: 'k1', consentAt: kst('2026-11-22T09:00:00'), origin: 'MOCK' }];
  const handoffs: HandoffRecord[] = [{ leadId: 'L1', dealer: 'dealer_a', sentAt: kst('2026-11-22T10:00:00') }, { leadId: 'L1', dealer: 'dealer_a', sentAt: kst('2026-11-22T10:30:00') }, { leadId: 'L1', dealer: 'dealer_b', sentAt: kst('2026-11-22T11:00:00') }];
  const before = buildLedger(leads, handoffs.slice(0, 2), []);
  assert.deepEqual(before.total, { mock: 0, real: 0 }); assert.deepEqual(before.unconfirmed, [{ leadId: 'L1', reason: 'NO_ACK' }]);
  const acks: AckRecord[] = [{ eventId: 'x1', leadId: 'L1', dealer: 'dealer_b', at: kst('2026-11-22T11:05:00'), evidence: 'dealer_ack_fixture' }, { eventId: 'x1', leadId: 'L1', dealer: 'dealer_b', at: kst('2026-11-22T11:06:00'), evidence: 'dealer_ack_fixture' }];
  const snap = composeProgressSnapshot(PROGRESS_SNAPSHOT, REAL_DEALER_INPUT, { leads, handoffs, acks });
  assert.equal(snap.rehearsal?.total, 1); assert.ok(screen(snap).includes('확인된 가상 접수: 1건'));
});

test('PL5 한국시간 일자 경계가 화면에 그대로: 23:59:59.999=22일, 00:00:00.000=23일, UTC 15:00 전후', () => {
  const mk = (n: number, at: string): [LeadRecord, HandoffRecord, AckRecord] => [{ leadId: `B${n}`, customerKey: `b${n}`, consentAt: 1, origin: 'MOCK' }, { leadId: `B${n}`, dealer: 'dealer_a', sentAt: kst('2026-11-22T10:00:00') }, { eventId: `bb${n}`, leadId: `B${n}`, dealer: 'dealer_a', at: kst(at), evidence: 'dealer_ack_fixture' }];
  const rows = [mk(1, '2026-11-22T23:59:59.999'), mk(2, '2026-11-23T00:00:00.000')];
  const snap = composeProgressSnapshot(PROGRESS_SNAPSHOT, REAL_DEALER_INPUT, { leads: rows.map((r) => r[0]), handoffs: rows.map((r) => r[1]), acks: rows.map((r) => r[2]) });
  assert.deepEqual(snap.rehearsal?.byDay, [{ day: '2026-11-22', count: 1 }, { day: '2026-11-23', count: 1 }]);
});

test('PL6 정적: 연결 모듈은 네트워크·환경·저장·타이머 없음, 진행판 page는 이 모듈로 불러오고 스냅샷 파일은 실적 null 유지', () => {
  const src = readFileSync('src/server/admin/progressLedger.ts', 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|fetch\(|console\.|setTimeout|setInterval|Date\.now|new Date\(\)|localStorage|postgres|supabase/i.test(src));
  assert.match(readFileSync('src/app/admin/progress/page.tsx', 'utf8'), /progressLedger'\)\)\.loadProgressSnapshot\(\)/);
  assert.equal(PROGRESS_SNAPSHOT.sales.value, null);
  assert.equal(PROGRESS_SNAPSHOT.rehearsal, undefined);
});
