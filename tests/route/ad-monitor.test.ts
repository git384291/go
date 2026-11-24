// 광고 정기 감시(PM 11/22 P0) — 가짜 DB·가짜 플랫폼만. 실제 Google 호출·지출 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAdMonitor, type MonitorTx } from '../../src/server/admin/adMonitor';
import { adMonitorHandler } from '../../src/server/admin/adMonitorRoute';
import { mockPlatform, type AdPlatform } from '../../src/server/advertising/platform';

const kst = (s: string) => new Date(`${s}+09:00`);
const RID = '11111111-2222-4333-8444-555555555555';
const L = (o: Record<string, unknown> = {}) => ({ campaign: 'camp-m', state: 'active', external_id: '4242', valid_until: '2026-11-25T13:00:00+09:00', end_date: '2026-11-24',
  days: [{ date: '2026-11-22', max_krw: 10000 }, { date: '2026-11-23', max_krw: 10000 }, { date: '2026-11-24', max_krw: 10000 }], ...o });
function db(launches: unknown[], o: { fail?: 'targets' | 'stop' | 'record' | 'begin'; busy?: boolean; total?: number; monthUsed?: number; monthLimit?: unknown } = {}) {
  const calls: { q: string; v: unknown[] }[] = [];
  const runAsMonitor = async <T,>(fn: (tx: MonitorTx) => Promise<T>): Promise<T> => fn((async (s: TemplateStringsArray, ...v: unknown[]) => {
    const q = s.join('?'); calls.push({ q, v });
    if (q.includes('ad_monitor_begin')) { if (o.fail === 'begin') throw new Error('db down'); return [{ r: !o.busy }]; }
    if (q.includes('ad_monitor_targets')) { if (o.fail === 'targets') throw new Error('db down'); return [{ r: { today: 'x', account_total_krw: o.total ?? 30000, month_used_krw: o.monthUsed ?? 0, month_limit_krw: 'monthLimit' in o ? o.monthLimit : 800000, launches } }]; }
    if (q.includes('ad_monitor_stop')) { if (o.fail === 'stop') throw new Error('x'); return [{ r: {} }]; }
    if (q.includes('ad_monitor_record')) { if (o.fail === 'record') throw new Error('x'); return []; }
    throw new Error('unexpected');
  }) as MonitorTx);
  return { runAsMonitor, calls, stops: () => calls.filter((c) => c.q.includes('ad_monitor_stop')).map((c) => c.v), record: () => calls.find((c) => c.q.includes('ad_monitor_record'))?.v };
}
const plat = (o: { cost?: (day: string) => number | null; pauseOk?: boolean; fetchThrows?: boolean; tz?: string | Error } = {}) => {
  const c = { pause: 0, fetch: [] as string[] };
  const p: AdPlatform = { ...mockPlatform, live: true,
    async accountTimeZone() { if (o.tz instanceof Error) throw o.tz; return o.tz ?? 'Asia/Seoul'; },
    async pause() { c.pause++; if (o.pauseOk === false) throw new Error('down'); return { paused: true }; },
    async fetchPerformance(_r, day) { c.fetch.push(day); if (o.fetchThrows) throw new Error('x'); const v = o.cost ? o.cost(day) : 1000; return { impressions: v === null ? null : 10, clicks: v === null ? null : 1, costKrw: v }; } };
  return { p, c };
};

test('AM1 72시간 승인·4개 날짜: 3일째(11/24) 23:59:59는 계속, 4일째(11/25) 00:00:00에 WINDOW_ENDED 중지 — 4일째 지출 차단', async () => {
  const a = db([L()]); const pa = plat();
  const r1 = await runAdMonitor({ platform: pa.p, now: () => kst('2026-11-24T23:59:59'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual([r1.ok, r1.stopped.length, pa.c.pause], [true, 0, 0]);
  assert.deepEqual(pa.c.fetch, ['2026-11-22', '2026-11-23', '2026-11-24']);
  const b = db([L()]); const pb = plat();
  const r2 = await runAdMonitor({ platform: pb.p, now: () => kst('2026-11-25T00:00:00'), runAsMonitor: b.runAsMonitor, runId: RID });
  assert.deepEqual(r2.stopped, [{ campaign: 'camp-m', code: 'WINDOW_ENDED', paused: true }]);
  assert.deepEqual(b.stops(), [['camp-m', 'WINDOW_ENDED', true]]);
  assert.equal(r2.ok, true);
});
test('AM2 승인 만료 시각이 지나면(기간 안이어도) APPROVAL_EXPIRED 중지, 승인 없음은 NO_ACTIVE_APPROVAL, 기간 기록 없음은 NO_WINDOW', async () => {
  for (const [l, now, code] of [[L({ valid_until: '2026-11-23T10:00:00+09:00' }), '2026-11-23T10:00:00', 'APPROVAL_EXPIRED'], [L({ valid_until: null }), '2026-11-22T12:00:00', 'NO_ACTIVE_APPROVAL'], [L({ days: [], end_date: null }), '2026-11-22T12:00:00', 'NO_WINDOW']] as const) {
    const a = db([l]); const p = plat();
    const r = await runAdMonitor({ platform: p.p, now: () => kst(now), runAsMonitor: a.runAsMonitor, runId: RID });
    assert.deepEqual(r.stopped.map((s) => s.code), [code]);
  }
});
test('AM3 날짜별 보고 비용이 그날 최대 청구액 초과면 DAY_OVER_MAX 중지, 이하·같음은 계속', async () => {
  const a = db([L()]); const p = plat({ cost: (d) => (d === '2026-11-23' ? 10001 : 5000) });
  const r = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-23T20:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual(r.stopped, [{ campaign: 'camp-m', code: 'DAY_OVER_MAX', paused: true }]);
  const b = db([L()]); const q = plat({ cost: () => 10000 });
  assert.deepEqual((await runAdMonitor({ platform: q.p, now: () => kst('2026-11-23T20:00:00'), runAsMonitor: b.runAsMonitor, runId: RID })).stopped, []);
});
test('AM4 보고 지연(null)·조회 실패는 UNKNOWN: 실행 기록 ok=false(→ DB가 새 집행 MONITOR_NOT_OK 차단), 0원으로 세지 않음', async () => {
  for (const o of [{ cost: () => null }, { fetchThrows: true }]) {
    const a = db([L()]); const p = plat(o);
    const r = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
    assert.equal(r.ok, false); assert.equal(r.recorded, true);
    assert.equal(a.record()![0], false);
    assert.ok(r.unknown.every((u) => u.code === 'SPEND_UNKNOWN' || u.code === 'FETCH_FAILED'));
  }
});
test('AM5 중지 실패(매체 pause 오류) → DB에 paused=false로 기록(경고 열림·계정 전체 STOP_PENDING), 실행 ok=false', async () => {
  const a = db([L()]); const p = plat({ pauseOk: false });
  const r = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-25T00:30:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual(a.stops(), [['camp-m', 'WINDOW_ENDED', false]]);
  assert.equal(r.ok, false); assert.ok(r.unknown.some((u) => u.code === 'STOP_FAILED'));
  const b = db([L()], { fail: 'stop' }); const q = plat();
  const r2 = await runAdMonitor({ platform: q.p, now: () => kst('2026-11-25T00:30:00'), runAsMonitor: b.runAsMonitor, runId: RID });
  assert.ok(r2.unknown.some((u) => u.code === 'STOP_RECORD_FAILED')); assert.equal(r2.ok, false);
});
test('AM6 정기 실행 실패: 대상 조회 실패면 기록 없이 ok=false(2시간 뒤 MONITOR_STALE), 기록 실패도 ok=false', async () => {
  const a = db([], { fail: 'targets' });
  const r = await runAdMonitor({ platform: plat().p, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual([r.ok, r.recorded, a.record()], [false, false, undefined]);
  const b = db([], { fail: 'record' });
  const r2 = await runAdMonitor({ platform: plat().p, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: b.runAsMonitor, runId: RID });
  assert.deepEqual([r2.ok, r2.recorded], [false, false]);
});
test('AM7 불명 launch(requested·unknown·외부 ID 없음)·플랫폼 없음은 UNKNOWN, 계정 보고 합계 3만 도달이면 전부 중지', async () => {
  for (const l of [L({ state: 'unknown', external_id: null }), L({ state: 'requested', external_id: null })]) {
    const a = db([l]); const r = await runAdMonitor({ platform: plat().p, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
    assert.deepEqual([r.ok, r.unknown[0]!.code], [false, 'LAUNCH_UNKNOWN']);
  }
  const n = db([L()]); assert.equal((await runAdMonitor({ platform: null, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: n.runAsMonitor, runId: RID })).unknown[0]!.code, 'PLATFORM_UNAVAILABLE');
  const a = db([L()]); const p = plat({ cost: () => 10000 });
  const r = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-24T20:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual(r.stopped.map((s) => s.code), ['ACCOUNT_TOTAL_REACHED']);
});
test('AM8 기록·결과에 외부 ID·비밀 없음(캠페인 키·고정 코드만)', async () => {
  const a = db([L({ external_id: '987654321' })]); const p = plat({ pauseOk: false });
  const r = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-25T00:30:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.ok(!JSON.stringify(r).includes('987654321') && !JSON.stringify(a.record()).includes('987654321'));
});
const ENV = { ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01', AD_MONITOR_SECRET: 's'.repeat(40) };
test('AM9 감시 경로: 비밀 없음·짧음·DB 꺼짐은 503(실행 0회), 틀린 인증 401, 맞으면 실행·결과 ok=false면 503', async () => {
  let n = 0;
  let busy = false; let rid = '';
  const run = (async (d: { runId: string }) => { n++; rid = d.runId; return { ok: false, busy, checked: 1, stopped: [], unknown: busy ? [] : [{ campaign: 'camp-m', code: 'SPEND_UNKNOWN' }], recorded: !busy }; }) as never;
  const req = (h?: string) => new Request('http://x/api/internal/ad-monitor', { method: 'POST', headers: h ? { authorization: h } : {} });
  for (const env of [{ ...ENV, AD_MONITOR_SECRET: undefined }, { ...ENV, AD_MONITOR_SECRET: 'short' }, { ...ENV, ADMIN_AD_SOURCE: 'mock' }]) assert.equal((await adMonitorHandler(req(`Bearer ${'s'.repeat(40)}`), env, run)).status, 503);
  for (const h of [undefined, 'Bearer x', `bearer ${'s'.repeat(40)}`, `Bearer ${'s'.repeat(39)}`]) assert.equal((await adMonitorHandler(req(h), ENV, run)).status, 401);
  assert.equal(n, 0);
  const r = await adMonitorHandler(req(`Bearer ${'s'.repeat(40)}`), ENV, run);
  assert.deepEqual([r.status, n], [503, 1]);
  assert.ok(!(await r.text()).includes('s'.repeat(40)));
  assert.match(rid, /^[0-9a-f-]{36}$/, '회차마다 새 run_id');
  // Vercel Cron 방식: CRON_SECRET만 있어도 'Bearer <CRON_SECRET>'로 인증(GET)
  const cron = { ...ENV, AD_MONITOR_SECRET: undefined, CRON_SECRET: 'c'.repeat(40) };
  assert.equal((await adMonitorHandler(new Request('http://x/api/internal/ad-monitor', { headers: { authorization: `Bearer ${'c'.repeat(40)}` } }), cron, run)).status, 503);
  assert.equal((await adMonitorHandler(new Request('http://x/api/internal/ad-monitor', { headers: { authorization: `Bearer ${'s'.repeat(40)}` } }), cron, run)).status, 401);
  // 중복 회차는 409
  busy = true;
  assert.equal((await adMonitorHandler(req(`Bearer ${'s'.repeat(40)}`), ENV, run)).status, 409);
});
test('AM10 정적: 경로 파일은 GET·POST·runtime·dynamic만 내보내고, 감시 모듈은 환경값·로그·타이머 직접 사용 없음', () => {
  const route = readFileSync('src/app/api/internal/ad-monitor/route.ts', 'utf8');
  assert.deepEqual([...route.matchAll(/^export (?:async function|const) (\w+)/gm)].map((m) => m[1]).sort(), ['GET', 'POST', 'dynamic', 'runtime']);
  const mon = readFileSync('src/server/admin/adMonitor.ts', 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  assert.ok(!/process\.env|console\.|setInterval|fetch\(/.test(mon));
});

test('AM11 중복·겹친 실행: 시작 기록을 못 잡으면(busy) 대상 조회·중지·기록 0회, 시작 기록 실패·잘못된 run_id도 아무것도 안 함', async () => {
  const a = db([L()], { busy: true }); const p = plat();
  const r = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-25T00:30:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual([r.busy, r.ok, r.recorded, p.c.pause], [true, false, false, 0]);
  assert.deepEqual(a.calls.map((c) => c.q.match(/ad_monitor_\w+/)![0]), ['ad_monitor_begin']);
  const b = db([L()], { fail: 'begin' });
  const r2 = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-25T00:30:00'), runAsMonitor: b.runAsMonitor, runId: RID });
  assert.deepEqual([r2.busy, r2.ok, b.calls.length], [false, false, 1]);
  const c = db([L()]);
  const r3 = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-25T00:30:00'), runAsMonitor: c.runAsMonitor, runId: 'not-a-uuid' });
  assert.deepEqual([r3.ok, c.calls.length], [false, 0]);
  const d = db([L()]); await runAdMonitor({ platform: p.p, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: d.runAsMonitor, runId: RID });
  assert.ok(String(d.record()![1]).includes(RID), '기록에 run_id(회차 종료 표시)');
});
test('AM12 계정 시간대: Asia/Seoul이 아니면 열린 캠페인 전부 중지(ACCOUNT_TIMEZONE_MISMATCH), 조회 실패는 UNKNOWN(새 집행 차단)', async () => {
  const a = db([L()]); const p = plat({ tz: 'America/Los_Angeles' });
  const r = await runAdMonitor({ platform: p.p, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual(r.stopped, [{ campaign: 'camp-m', code: 'ACCOUNT_TIMEZONE_MISMATCH', paused: true }]);
  const b = db([L()]); const q = plat({ tz: new Error('x') });
  const r2 = await runAdMonitor({ platform: q.p, now: () => kst('2026-11-22T12:00:00'), runAsMonitor: b.runAsMonitor, runId: RID });
  assert.equal(r2.ok, false); assert.ok(r2.unknown.some((u) => u.code === 'ACCOUNT_CHECK_FAILED'));
});

// PM 11/25 광고 월 예산(0034) — M9·M10·M7: 가짜 DB·가짜 플랫폼만
test('AM13(M9) 이번 달 사용액이 판정 한도 이상이면 열린 캠페인 전부 MONTHLY_CAP_REACHED 중지, 한도 미만이면 계속, 미설정(0원)이면 MONTHLY_BUDGET_UNSET 중지', async () => {
  const now = () => kst('2026-11-23T12:00:00');
  const two = [L(), L({ campaign: 'camp-n', external_id: '4343' })];
  const a = db(two, { monthUsed: 7999, monthLimit: 8000 }); const pa = plat({ cost: () => 0 });
  const r1 = await runAdMonitor({ platform: pa.p, now, runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual([r1.ok, r1.stopped.length], [true, 0], '한도 1원 전: 계속');
  for (const [used, limit, code] of [[8000, 8000, 'MONTHLY_CAP_REACHED'], [9000, 8000, 'MONTHLY_CAP_REACHED'], [0, 0, 'MONTHLY_BUDGET_UNSET']] as const) {
    const b = db(two, { monthUsed: used, monthLimit: limit }); const pb = plat({ cost: () => 0 });
    const r = await runAdMonitor({ platform: pb.p, now, runAsMonitor: b.runAsMonitor, runId: RID });
    assert.deepEqual(r.stopped.map((s) => [s.campaign, s.code, s.paused]), [['camp-m', code, true], ['camp-n', code, true]], `${used}/${limit}`);
    assert.deepEqual(b.stops(), [['camp-m', code, true], ['camp-n', code, true]], 'DB 승인 철회 기록');
    assert.equal(pb.c.pause, 2);
  }
});

test('AM14(M8) 지연 보고: DB 사용액에 아직 없는 이번 달 보고 초과분을 더해 판정(7,000 + 초과 1,500 ≥ 8,000 → 중지), 지난달 날짜 초과분은 이번 달에 넣지 않음', async () => {
  const two = [L(), L({ campaign: 'camp-n', external_id: '4343' })];
  const a = db(two, { monthUsed: 7000, monthLimit: 8000 }); const pa = plat({ cost: (d) => (d === '2026-11-22' && pa.c.fetch.length === 1 ? 11500 : 0) });
  const r = await runAdMonitor({ platform: pa.p, now: () => kst('2026-11-23T12:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.deepEqual(r.stopped.map((s) => [s.campaign, s.code]), [['camp-m', 'DAY_OVER_MAX'], ['camp-n', 'MONTHLY_CAP_REACHED']], '초과 캠페인은 기존대로, 다른 캠페인은 월 예산으로 중지');
  const c = db(two, { monthUsed: 6000, monthLimit: 8000 }); const pc = plat({ cost: (d) => (d === '2026-11-22' && pc.c.fetch.length === 1 ? 11500 : 0) });
  const r3 = await runAdMonitor({ platform: pc.p, now: () => kst('2026-11-23T12:00:00'), runAsMonitor: c.runAsMonitor, runId: RID });
  assert.deepEqual(r3.stopped.map((s) => [s.campaign, s.code]), [['camp-m', 'DAY_OVER_MAX']], '6,000 + 1,500 < 8,000 → 다른 캠페인은 계속');
  const cross = [L({ days: [{ date: '2026-10-31', max_krw: 10000 }, { date: '2026-11-01', max_krw: 10000 }], end_date: '2026-11-01', valid_until: '2026-11-02T13:00:00+09:00' })];
  const b = db(cross, { monthUsed: 7000, monthLimit: 8000 }); const pb = plat({ cost: (d) => (d === '2026-10-31' ? 10000 : 500) });
  const r2 = await runAdMonitor({ platform: pb.p, now: () => kst('2026-11-01T12:00:00'), runAsMonitor: b.runAsMonitor, runId: RID });
  assert.deepEqual([r2.ok, r2.stopped.length], [true, 0], '10월 날짜 값은 11월 사용액에 더하지 않음');
});

test('AM15(M10) 월 예산 중지에서 매체 pause 실패 → paused=false 기록(경고·계정 전체 STOP_PENDING), 결과 ok=false·STOP_FAILED(성공으로 표시하지 않음)', async () => {
  const a = db([L()], { monthUsed: 8000, monthLimit: 8000 }); const pa = plat({ cost: () => 0, pauseOk: false });
  const r = await runAdMonitor({ platform: pa.p, now: () => kst('2026-11-23T12:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
  assert.equal(r.ok, false);
  assert.deepEqual(a.stops(), [['camp-m', 'MONTHLY_CAP_REACHED', false]]);
  assert.ok(r.unknown.some((u) => u.code === 'STOP_FAILED'));
  assert.equal((a.record() as unknown[])[0], false, '실행 기록 ok=false → DB가 새 집행 MONITOR_NOT_OK 차단');
});

test('AM16(M7) 월 값 없음·음수·소수·문자 = 대상 조회 실패(TARGETS_UNAVAILABLE): 중지·기록 없이 ok=false(2시간 뒤 MONITOR_STALE로 새 집행 차단)', async () => {
  for (const bad of [undefined, -1, 1.5, '8000', null]) {
    const a = db([L()], { monthLimit: bad }); const pa = plat();
    const r = await runAdMonitor({ platform: pa.p, now: () => kst('2026-11-23T12:00:00'), runAsMonitor: a.runAsMonitor, runId: RID });
    assert.equal(r.ok, false, String(bad));
    assert.deepEqual(r.unknown, [{ campaign: '-', code: 'TARGETS_UNAVAILABLE' }]);
    assert.equal(a.record(), undefined);
    assert.equal(pa.c.fetch.length, 0);
  }
});
