import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSpend } from '../../src/server/advertising/budgetGuard';

const base = (days: unknown, d = 10000, t = 30000) => ({ dailyCapKrw: d, totalCapKrw: t, days });
const day = (date: string, spendKrw: number | null) => ({ date, spendKrw });

test('BG1 한도 안이면 OK', () => {
  const r = judgeSpend(base([day('2026-11-23', 3000)]));
  assert.deepEqual(r, { ok: true, action: 'OK', reasons: [], totalSpendKrw: 3000 });
});
test('BG2 80% 이상이면 WARN(아직 중단 아님)', () => {
  const r = judgeSpend(base([day('2026-11-23', 8000)]));
  assert.equal(r.ok && r.action, 'WARN');
});
test('BG3 일 한도 도달·초과는 STOP_REQUIRED', () => {
  for (const s of [10000, 10001]) {
    const r = judgeSpend(base([day('2026-11-23', s)]));
    assert.ok(r.ok && r.action === 'STOP_REQUIRED' && r.reasons.includes('DAILY_CAP_REACHED'));
  }
});
test('BG4 누적 한도 도달은 STOP_REQUIRED', () => {
  const r = judgeSpend(base([day('2026-11-23', 9000), day('2026-11-24', 9000), day('2026-11-25', 9000)], 10000, 27000));
  assert.ok(r.ok && r.action === 'STOP_REQUIRED' && r.reasons.includes('TOTAL_CAP_REACHED'));
});
test('BG5 지출 미확인(null)은 정상으로 보지 않는다(fail-closed)', () => {
  const r = judgeSpend(base([day('2026-11-23', null)]));
  assert.ok(r.ok && r.action === 'STOP_REQUIRED' && r.totalSpendKrw === null && r.reasons.includes('UNKNOWN_SPEND'));
});
test('BG6 같은 날짜 중복은 STOP_REQUIRED', () => {
  const r = judgeSpend(base([day('2026-11-23', 100), day('2026-11-23', 100)]));
  assert.ok(r.ok && r.action === 'STOP_REQUIRED' && r.reasons.includes('DUPLICATE_DATE'));
});
test('BG7 승인 상한을 넘는 한도·형식 오류·추가 키는 거부', () => {
  const bad: unknown[] = [
    base([day('2026-11-23', 1)], 10001), base([day('2026-11-23', 1)], 10000, 30001), base([day('2026-11-23', 1)], 0),
    base([]), base([day('2026-11-23', 1), day('2026-11-24', 1), day('2026-11-25', 1), day('2026-11-26', 1)]),
    base([day('2026-02-30', 1)]), base([day('2026-11-23', -1)]), base([day('2026-11-23', 1.5)]), base([day('2026-11-23', '1')]),
    { ...base([day('2026-11-23', 1)]), extra: 1 }, null, [], 'x',
  ];
  for (const b of bad) assert.deepEqual(judgeSpend(b), { ok: false, error: 'INVALID_INPUT' }, JSON.stringify(b));
});
test('BG8 결과는 고정되고 집행 허용 필드가 없다', () => {
  const r = judgeSpend(base([day('2026-11-23', 100)]));
  assert.ok(Object.isFrozen(r));
  assert.equal('executionAllowed' in r, false);
});
