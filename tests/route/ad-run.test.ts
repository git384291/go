// 광고 집행 요청·성과 수집·분석 서버 모듈 시험(가짜 의존성). 실제 광고 API·과금 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { adFunnel, adRunAction, type AdRunDeps } from '../../src/server/admin/adRun';
import { PlatformError, callPlatform, createPlatform, mockPlatform, type AdPlatform } from '../../src/server/advertising/platform';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const NOW = new Date('2026-11-21T03:00:00Z'); // KST 12:00 11/21
const ENV = { ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const KEY = 'req-0123456789abcdef';
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'secret-tok', role }) as StaffIdentity;
const spy = (live = false, over: Partial<AdPlatform> = {}) => { const c = { launch: 0, fetch: 0, pause: 0 }; const p: AdPlatform = { name: 'spy', live, async launch(req) { c.launch++; return { externalId: 'ext-1', dailyBudgetKrw: req.platformDailyBudgetKrw }; }, async pause() { c.pause++; return { paused: true }; }, async fetchPerformance() { c.fetch++; return { impressions: 1000, clicks: 40, costKrw: 400 }; }, ...over }; return { p, c }; };
// launch 상태 DB 가짜 응답(기본: 열린 launch 없음·시작/완료/중지 기록 성공)
const launchDefault = (q: string): unknown => (q.includes('ad_launch_begin') ? [{ r: { ok: true } }] : q.includes('ad_launch_active') ? [{ r: null }] : q.includes('ad_launch_paused') ? [{ r: { ok: true, paused: true } }] : [{}]);
function mk(o: { env?: Record<string, string | undefined>; staff?: StaffIdentity | Error; platform?: AdPlatform | null; tx?: (q: string) => unknown; ltx?: (q: string) => unknown } = {}) {
  const c = { staff: 0, tx: 0, sql: [] as string[] };
  const d: AdRunDeps = {
    env: () => o.env ?? ENV, mode: () => 'supabase', platform: o.platform === undefined ? mockPlatform : o.platform,
    requireStaff: async () => { c.staff++; if (o.staff instanceof Error) throw o.staff; return o.staff ?? who('owner'); },
    runInTransaction: async (fn) => { c.tx++; const tag = (async (s: TemplateStringsArray) => { const q = s.join('?'); c.sql.push(q); const r = q.includes('api.ad_launch_') ? (o.ltx ? o.ltx(q) : launchDefault(q)) : o.tx ? o.tx(q) : [{ r: { decision: 'ALLOW', recorded: true, over_ledger: false } }]; if (r instanceof Error) throw r; return r; }) as never; return fn(tag); },
    now: () => NOW,
  };
  return { d, c };
}
const launch = (o: Record<string, unknown> = {}) => ({ action: 'launch', campaign: 'camp-a', amountKrw: 1000, requestKey: KEY, ...o });
const collect = (o: Record<string, unknown> = {}) => ({ action: 'collect', campaign: 'camp-a', day: '2026-11-20', ...o });
const j = async (r: Response) => (await r.json()) as Record<string, unknown>;

test('AR1 기본 닫힘·권한: 환경 미충족 503, owner 아니면 403, 플랫폼 호출 0회', async () => {
  for (const env of [{}, { ADMIN_AD_SOURCE: 'mock' }, { ...ENV, NODE_ENV: 'production' }]) {
    const s = spy(); const { d, c } = mk({ env, platform: s.p });
    for (const b of [launch(), collect()]) assert.equal((await adRunAction(d, b)).status, 503);
    assert.equal(c.staff + c.tx + s.c.launch + s.c.fetch, 0);
  }
  for (const role of ['policy_editor', 'reviewer', 'counselor']) {
    const s = spy(); const { d, c } = mk({ staff: who(role), platform: s.p });
    const r = await adRunAction(d, launch());
    assert.equal(r.status, 403); assert.equal((await j(r)).decision, 'BLOCK');
    assert.equal((await adRunAction(d, collect())).status, 403);
    assert.equal(c.tx + s.c.launch + s.c.fetch, 0);
  }
  assert.equal((await adRunAction(mk({ staff: new StaffAuthError(401, 'X') }).d, launch())).status, 401);
});
test('AR2 모의 어댑터: 승인 판정 ALLOW여도 executed=false(simulated), 과금·집행 없음', async () => {
  const { d } = mk();
  const r = await adRunAction(d, launch());
  const b = await j(r);
  assert.equal(r.status, 200); assert.deepEqual([b.ok, b.decision, b.executed, b.simulated], [true, 'ALLOW', false, true]);
  assert.match(String(b.externalId), /^mock-/);
});
test('AR3 실제(live) 어댑터는 AD_EXECUTION_ENABLED=true 없이는 DB 판정·플랫폼 호출 0회로 차단', async () => {
  for (const env of [ENV, { ...ENV, AD_EXECUTION_ENABLED: '1' }, { ...ENV, AD_EXECUTION_ENABLED: 'TRUE' }]) {
    const s = spy(true); const { d, c } = mk({ env, platform: s.p });
    const r = await adRunAction(d, launch());
    assert.deepEqual([r.status, (await j(r)).reason], [403, 'EXECUTION_DISABLED']);
    assert.equal(c.tx + s.c.launch, 0);
  }
  const s = spy(true); const { d } = mk({ env: { ...ENV, AD_EXECUTION_ENABLED: 'true' }, platform: s.p });
  const ok = await j(await adRunAction(d, launch()));
  assert.deepEqual([ok.ok, ok.executed, s.c.launch], [true, true, 1]); // 스위치+승인이 모두 있을 때만
});
test('AR4 DB 판정이 BLOCK(승인 없음·한도·중복)이면 플랫폼 호출 0회', async () => {
  for (const reason of ['NO_APPROVAL', 'DAILY_CAP_EXCEEDED', 'TOTAL_CAP_EXCEEDED', 'DUPLICATE_REQUEST', 'APPROVAL_EXPIRED']) {
    const s = spy(); const { d } = mk({ platform: s.p, tx: () => [{ r: { decision: 'BLOCK', reason } }] });
    const b = await j(await adRunAction(d, launch()));
    assert.deepEqual([b.ok, b.decision, b.reason, s.c.launch], [false, 'BLOCK', reason, 0]);
  }
});
test('AR5 오류는 차단: DB 예외·형식 밖 응답·권한 오류, 플랫폼 오류는 지출 기록 표시', async () => {
  for (const tx of [() => new Error('boom'), () => [{ r: 'ALLOW' }], () => [], () => [{ r: { decision: 'MAYBE' } }]]) {
    const s = spy(); const { d } = mk({ platform: s.p, tx });
    const r = await adRunAction(d, launch());
    assert.equal((await j(r)).decision, 'BLOCK'); assert.ok(r.status >= 502); assert.equal(s.c.launch, 0);
  }
  const e42501 = Object.assign(new Error('x'), { code: '42501' });
  const r = await adRunAction(mk({ tx: () => e42501 }).d, launch());
  assert.deepEqual([r.status, (await j(r)).reason], [403, 'FORBIDDEN']);
  const s = spy(false, { async launch() { throw new Error('platform secret key abc'); } });
  const pe = await adRunAction(mk({ platform: s.p }).d, launch());
  const b = await j(pe);
  // 분류되지 않은 예외는 집행 여부를 알 수 없으므로 unknown(자동 재시도 금지)
  assert.deepEqual([pe.status, b.decision, b.reason, b.spendRecorded, b.outcome, b.needsReview], [502, 'BLOCK', 'PLATFORM_UNKNOWN', true, 'unknown', true]);
  const sf = spy(false, { async launch() { throw new PlatformError('failed', 'REJECTED'); } });
  const pf = await j(await adRunAction(mk({ platform: sf.p }).d, launch()));
  assert.deepEqual([pf.reason, pf.outcome, pf.spendRecorded], ['PLATFORM_ERROR', 'failed', true]);
  assert.ok(!JSON.stringify(b).includes('secret'));
  assert.equal((await adRunAction(mk({ platform: null }).d, launch())).status, 503);
});
test('AR6 입력 검사: 여분 키·형식·금액 상한·요청 키 → 422(DB·플랫폼 0회)', async () => {
  for (const bad of [{ extra: 1 }, { campaign: 'Bad Key' }, { amountKrw: 0 }, { amountKrw: 10001 }, { amountKrw: 1.5 }, { amountKrw: '1000' }, { requestKey: 'short' }]) {
    const s = spy(); const { d, c } = mk({ platform: s.p });
    const r = await adRunAction(d, launch(bad));
    assert.equal(r.status, 422, JSON.stringify(bad)); assert.equal((await j(r)).decision, 'BLOCK');
    assert.equal(c.tx + s.c.launch, 0);
  }
  for (const bad of [{ day: '2026-02-31' }, { day: '2026-11-22' }, { day: 'x' }, { campaign: 'A' }, { extra: 1 }]) {
    const s = spy(); const { d, c } = mk({ platform: s.p });
    assert.equal((await adRunAction(d, collect(bad))).status, 422, JSON.stringify(bad));
    assert.equal(c.tx + s.c.fetch, 0);
  }
  assert.equal((await adRunAction(mk().d, { action: 'nope' })).status, 400);
});
test('AR7 성과 수집: 어댑터 값 재검증(클릭>노출·음수·비정수·형식 밖은 DB 0회), 정상은 mock 출처로 기록', async () => {
  for (const perf of [{ impressions: 10, clicks: 11, costKrw: 0 }, { impressions: -1, clicks: 0, costKrw: 0 }, { impressions: 1.5, clicks: 0, costKrw: 0 }, { impressions: 10, clicks: 1, costKrw: 'x' }, null, 'x']) {
    const s = spy(false, { async fetchPerformance() { return perf; } }); const { d, c } = mk({ platform: s.p });
    const r = await adRunAction(d, collect());
    assert.deepEqual([r.status, (await j(r)).code], [502, 'PLATFORM_DATA_INVALID']); assert.ok(!c.sql.some((q) => q.includes('ad_performance_record')));
  }
  const { d, c } = mk({ tx: () => [{ r: { recorded: true, over_ledger: true } }] });
  const b = await j(await adRunAction(d, collect()));
  assert.deepEqual([b.ok, b.recorded, b.overLedger, b.source], [true, true, true, 'mock']);
  assert.ok(c.sql.some((q) => q.includes('api.ad_performance_record')));
  const boom = await adRunAction(mk({ platform: spy(false, { async fetchPerformance() { throw new Error('x'); } }).p }).d, collect());
  assert.equal(boom.status, 502);
});
test('AR8 분석: owner·reviewer 조회, 기간 검증, 비율 계산, 상담 단계 미집계 표시, 이상 값은 거부', async () => {
  const rows = [{ campaign_key: 'camp-a', impressions: '1000', clicks: '40', cost_krw: '400', ledger_krw: '500', consults: '8', leads: '2', overspend_days: '0' }, { campaign_key: 'camp-b', impressions: '0', clicks: '0', cost_krw: '0', ledger_krw: '0', consults: '0', leads: '1', overspend_days: '1' }];
  const ok = await adFunnel(mk({ staff: who('reviewer'), tx: () => rows }).d, new Request('http://x/api/admin/ads/funnel'));
  const b = await j(ok);
  assert.equal(ok.status, 200); assert.equal(b.consultTracked, true);
  const [a, c2] = b.items as Record<string, unknown>[];
  assert.deepEqual([a.clickRate, a.consultRate, a.leadRate, a.costPerLeadKrw, a.overBudget], [0.04, 0.2, 0.25, 200, false]);
  assert.deepEqual([c2.clickRate, c2.consultRate, c2.leadRate, c2.overBudget], [null, null, null, true]);
  assert.equal((await adFunnel(mk({ staff: who('counselor') }).d, new Request('http://x/'))).status, 403);
  for (const q of ['from=2026-11-22&to=2026-11-21', 'to=2026-11-22', 'from=bad', 'from=2026-02-31']) assert.equal((await adFunnel(mk().d, new Request(`http://x/?${q}`))).status, 400, q);
  assert.equal((await adFunnel(mk({ tx: () => [{ ...rows[0], clicks: 'abc' }] }).d, new Request('http://x/'))).status, 502);
  assert.equal((await adFunnel(mk({ tx: () => new Error('x') }).d, new Request('http://x/'))).status, 503);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
});
test('AR10 초과 감지 자동 중지: 초과일 때만 승인 철회(DB)+플랫폼 중지, 정상·중복은 중지 안 함, 한쪽 실패해도 다른 쪽 진행·결과 그대로 보고', async () => {
  // 정상(초과 아님) → 중지 없음
  const s0 = spy(); const m0 = mk({ platform: s0.p, tx: () => [{ r: { recorded: true, over_ledger: false } }] });
  const b0 = await j(await adRunAction(m0.d, collect()));
  assert.deepEqual([b0.ok, 'autoStop' in b0, s0.c.pause, m0.c.sql.some((q) => q.includes('ad_budget_revoke'))], [true, false, 0, false]);
  // 이미 기록된 날짜(recorded=false) → 중지 없음
  const s1 = spy(); const m1 = mk({ platform: s1.p, tx: () => [{ r: { recorded: false, over_ledger: null } }] });
  assert.equal('autoStop' in (await j(await adRunAction(m1.d, collect()))), false);
  assert.equal(s1.c.pause, 0);
  // 초과 → 철회 먼저, 그다음 플랫폼 중지
  const order: string[] = [];
  const s2 = spy(false, { async pause() { order.push('pause'); return { paused: true }; } });
  const m2 = mk({ platform: s2.p, tx: (q) => { order.push(q.includes('ad_budget_revoke') ? 'revoke' : 'record'); return [{ r: { recorded: true, over_ledger: true } }]; } });
  const b2 = await j(await adRunAction(m2.d, collect()));
  assert.deepEqual(order, ['record', 'revoke', 'pause']);
  assert.deepEqual(b2.autoStop, { revoked: true, revokeNote: null, paused: true, pauseNote: null, simulated: true, alert: null });
  // 철회 실패(승인 이미 없음 22023 / 그 밖의 오류)여도 플랫폼 중지는 진행, 결과 그대로 보고
  for (const [code, note] of [['22023', 'NO_ACTIVE_APPROVAL'], ['XX000', 'REVOKE_FAILED']] as const) {
    const s3 = spy();
    const m3 = mk({ platform: s3.p, tx: (q) => (q.includes('ad_budget_revoke') ? Object.assign(new Error('x'), { code }) : [{ r: { recorded: true, over_ledger: true } }]) });
    const b3 = await j(await adRunAction(m3.d, collect()));
    assert.deepEqual([(b3.autoStop as Record<string, unknown>).revoked, (b3.autoStop as Record<string, unknown>).revokeNote, (b3.autoStop as Record<string, unknown>).paused, s3.c.pause], [false, note, true, 1]);
  }
  // 플랫폼 중지 실패여도 철회는 끝났고 paused=false로 알림(응답은 성공, 비밀 노출 없음)
  const s4 = spy(false, { async pause() { throw new Error('platform secret xyz'); } });
  const m4 = mk({ platform: s4.p, tx: () => [{ r: { recorded: true, over_ledger: true } }] });
  const r4 = await adRunAction(m4.d, collect());
  const b4 = await j(r4);
  assert.deepEqual([r4.status, (b4.autoStop as Record<string, unknown>).revoked, (b4.autoStop as Record<string, unknown>).paused], [200, true, false]);
  assert.ok(!JSON.stringify(b4).includes('secret'));
  // 중지 불완전(플랫폼 실패·철회 실패) → 관리자 경고를 연다(ad_alert_open). 완전 성공·승인 이미 없음은 경고 없음
  assert.ok(m4.c.sql.some((q) => q.includes('ad_alert_open')));
  assert.ok(!m2.c.sql.some((q) => q.includes('ad_alert_open')));
  const ID = '11111111-1111-4111-8111-111111111111';
  const m5 = mk({ platform: spy(false, { async pause() { throw new Error('x'); } }).p, tx: (q) => (q.includes('ad_alert_open') ? [{ id: ID }] : [{ r: { recorded: true, over_ledger: true } }]) });
  assert.deepEqual(((await j(await adRunAction(m5.d, collect()))).autoStop as Record<string, unknown>).alert, { opened: true });
  // 경고 기록까지 실패해도 응답은 성공이며 opened=false로 정직하게 보고
  const m6 = mk({ platform: spy(false, { async pause() { throw new Error('x'); } }).p, tx: (q) => (q.includes('ad_alert_open') ? Object.assign(new Error('db'), { code: 'XX000' }) : [{ r: { recorded: true, over_ledger: true } }]) });
  const r6 = await adRunAction(m6.d, collect());
  assert.deepEqual([r6.status, ((await j(r6)).autoStop as Record<string, unknown>).alert], [200, { opened: false }]);
});
test('AR11 경고 해결: owner만, 사유·id 형식 검사, DB 오류 그대로 안전하게 변환, 플랫폼 호출 0', async () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const s = spy(); const m = mk({ platform: s.p, tx: () => [{ ok: true }] });
  const r = await adRunAction(m.d, { action: 'alert_resolve', id: ID, note: '플랫폼 콘솔에서 직접 중지 확인' });
  assert.equal(r.status, 200);
  assert.ok(m.c.sql.some((q) => q.includes('ad_alert_resolve')));
  assert.equal(s.c.pause + s.c.launch + s.c.fetch, 0);
  for (const bad of [{ id: 'x', note: 'nn' }, { id: ID, note: '' }, { id: ID, note: '   ' }, { id: ID }, { id: ID, note: 'nn', extra: 1 }]) {
    const mm = mk(); assert.equal((await adRunAction(mm.d, { action: 'alert_resolve', ...bad })).status, 422); assert.equal(mm.c.tx, 0);
  }
  const mn = mk({ tx: () => Object.assign(new Error('NO_OPEN_ALERT'), { code: '22023' }) });
  assert.equal((await adRunAction(mn.d, { action: 'alert_resolve', id: ID, note: 'nn' })).status, 422);
  const mf = mk({ staff: who('reviewer') });
  assert.equal((await adRunAction(mf.d, { action: 'alert_resolve', id: ID, note: 'nn' })).status, 403);
  assert.equal(mf.c.tx, 0);
});
test('AR9 모의 어댑터는 결정적이고 형식이 맞음, AD_PLATFORM=mock 외에는 어댑터 없음, 정적: 실제 광고 API 주소·fetch 없음', async () => {
  const ref = { campaign: 'camp-a', externalId: 'mock-1' }; const o = { deadlineAt: Date.now() + 1000 };
  const a = await mockPlatform.fetchPerformance(ref, '2026-11-20', o);
  assert.deepEqual(a, await mockPlatform.fetchPerformance(ref, '2026-11-20', o));
  const p = a as { impressions: number; clicks: number; costKrw: number };
  assert.ok(p.clicks <= p.impressions && p.costKrw === p.clicks * 10);
  assert.equal(mockPlatform.live, false);
  assert.deepEqual(await mockPlatform.pause(ref, o), { paused: true });
  assert.equal(createPlatform({ AD_PLATFORM: 'mock' }), mockPlatform);
  for (const v of [undefined, '', 'google', 'naver', 'MOCK']) assert.equal(createPlatform({ AD_PLATFORM: v }), null);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  for (const f of ['src/server/advertising/platform.ts', 'src/server/admin/adRun.ts']) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/fetch\(|googleads|searchad\.naver|api\.openai|XMLHttpRequest/.test(s), `${f}: 외부 호출 없음`);
  }
  for (const f of walk('src').filter((x) => /\.(ts|tsx)$/.test(x))) {
    const s = readFileSync(f, 'utf8');
    if (/^['"]use client['"]/.test(s.trimStart())) assert.ok(!/AD_EXECUTION_ENABLED|AD_PLATFORM|server\/advertising\/platform/.test(s), `${f}: 클라이언트 파일`);
  }
});

const ACTIVE = (q: string): unknown => (q.includes('ad_launch_active') ? [{ r: { state: 'active', external_id: 'ext-9', request_key: KEY, amount_krw: 1000 } }] : launchDefault(q));
test('AR12 launch 상태 저장: begin→지출판정→플랫폼→finish 순서, 플랫폼 일 예산 상한=승인 금액, externalId 저장', async () => {
  const order: string[] = []; let seen: { platformDailyBudgetKrw?: number; deadlineAt?: number; requestKey?: string } = {};
  const s = spy(false, { async launch(req) { order.push('platform'); seen = req; return { externalId: 'ext-1', dailyBudgetKrw: req.platformDailyBudgetKrw }; } });
  const m = mk({ platform: s.p, ltx: (q) => { order.push(q.match(/ad_launch_\w+/)![0]); return launchDefault(q); }, tx: () => { order.push('spend'); return [{ r: { decision: 'ALLOW' } }]; } });
  const b = await j(await adRunAction(m.d, launch()));
  assert.deepEqual(order, ['ad_launch_begin', 'spend', 'platform', 'ad_launch_finish']);
  assert.deepEqual([b.ok, b.externalId, b.platformDailyBudgetKrw, seen.platformDailyBudgetKrw, seen.requestKey, typeof seen.deadlineAt], [true, 'ext-1', 1000, 1000, KEY, 'number']);
});
test('AR13 중복 active launch·같은 요청 키: DB가 막으면 지출 판정·플랫폼 호출 0회', async () => {
  for (const reason of ['LAUNCH_ACTIVE', 'LAUNCH_UNKNOWN', 'DUPLICATE_REQUEST']) {
    const s = spy(); const m = mk({ platform: s.p, ltx: () => [{ r: { ok: false, reason } }] });
    const b = await j(await adRunAction(m.d, launch()));
    assert.deepEqual([b.decision, b.reason, s.c.launch, m.c.sql.some((q) => q.includes('ad_spend_request'))], ['BLOCK', reason, 0, false]);
  }
});
test('AR14 시간 초과(unknown): 자동 재launch 없음·unknown 저장·사람 확인 필요 표시, 비밀 노출 없음', async () => {
  const s = spy(false, { async launch() { return new Promise(() => undefined); } });
  const t0 = Date.now();
  const pr = await callPlatform(() => s.p.launch({ campaign: 'c', amountKrw: 1, requestKey: KEY, platformDailyBudgetKrw: 1, deadlineAt: Date.now() }), 30);
  assert.deepEqual(pr, { status: 'unknown', code: 'TIMEOUT' }); assert.ok(Date.now() - t0 < 2000);
  const f = await callPlatform(async () => { throw new PlatformError('failed', 'REJECTED'); });
  assert.deepEqual(f, { status: 'failed', code: 'REJECTED' });
  const states: string[] = [];
  const su = spy(false, { async launch() { throw new PlatformError('unknown', 'TIMEOUT'); } });
  const m = mk({ platform: su.p, ltx: (q) => { if (q.includes('ad_launch_finish')) states.push('finish'); return launchDefault(q); } });
  const b = await j(await adRunAction(m.d, launch()));
  assert.deepEqual([b.reason, b.outcome, b.needsReview, su.c.launch, states.length], ['PLATFORM_UNKNOWN', 'unknown', true, 0, 1]);
});
test('AR15 플랫폼 일 예산 상한이 승인 금액을 넘으면 계약 위반: 즉시 철회·중지·경고', async () => {
  const s = spy(false, { async launch() { return { externalId: 'ext-1', dailyBudgetKrw: 99999 }; } });
  const m = mk({ platform: s.p, ltx: ACTIVE, tx: (q) => (q.includes('ad_alert_open') ? [{ id: '11111111-1111-4111-8111-111111111111' }] : [{ r: { decision: 'ALLOW' } }]) });
  const r = await adRunAction(m.d, launch());
  const b = await j(r);
  assert.deepEqual([r.status, b.reason], [502, 'PLATFORM_BUDGET_NOT_PROTECTED']);
  assert.ok(m.c.sql.some((q) => q.includes('ad_budget_revoke')) && s.c.pause === 1);
});
test('AR16 수동 중지: owner만, 승인 철회 → 플랫폼 pause(externalId) → 기록, 실패 시 경고', async () => {
  const order: string[] = []; let ext: string | null = null;
  const s = spy(false, { async pause(ref) { order.push('pause'); ext = ref.externalId; return { paused: true }; } });
  const m = mk({ platform: s.p, ltx: ACTIVE, tx: (q) => { order.push(q.includes('ad_budget_revoke') ? 'revoke' : 'other'); return [{}]; } });
  const b = await j(await adRunAction(m.d, { action: 'pause', campaign: 'camp-a', reason: '수동 확인' }));
  assert.deepEqual([order.filter((x) => x !== 'other'), ext, (b as { paused?: boolean }).paused, (b as { revoked?: boolean }).revoked], [['revoke', 'pause'], 'ext-9', true, true]);
  assert.ok(m.c.sql.some((q) => q.includes('ad_launch_paused')));
  assert.equal((await adRunAction(mk({ staff: who('reviewer') }).d, { action: 'pause', campaign: 'camp-a', reason: '수동 확인' })).status, 403);
  assert.equal((await adRunAction(mk().d, { action: 'pause', campaign: 'camp-a', reason: '' })).status, 422);
  const sf = spy(false, { async pause() { throw new PlatformError('unknown', 'TIMEOUT'); } });
  const mf = mk({ platform: sf.p, ltx: ACTIVE, tx: (q) => (q.includes('ad_alert_open') ? [{ id: '11111111-1111-4111-8111-111111111111' }] : [{}]) });
  const bf = await j(await adRunAction(mf.d, { action: 'pause', campaign: 'camp-a', reason: '수동 확인' }));
  assert.deepEqual([bf.paused, bf.pauseNote, (bf.alert as { opened: boolean }).opened], [false, 'TIMEOUT', true]);
});
test('AR17 launch_resolve(대표 전용·사유 필수)와 collect의 externalId 사용', async () => {
  const body = { action: 'launch_resolve', requestKey: KEY, outcome: 'executed', externalId: 'ext-5', reason: '플랫폼 콘솔 확인' };
  assert.equal((await adRunAction(mk().d, body)).status, 200);
  assert.equal((await adRunAction(mk({ staff: who('reviewer') }).d, body)).status, 403);
  for (const bad of [{ reason: ' ' }, { externalId: null }, { outcome: 'x' }, { requestKey: 'x' }]) assert.equal((await adRunAction(mk().d, { ...body, ...bad })).status, 422);
  let got: string | null = null;
  const s = spy(true, { async fetchPerformance(ref) { got = ref.externalId; return { impressions: 10, clicks: 1, costKrw: 10 }; } });
  const env = { ...ENV, AD_EXECUTION_ENABLED: 'true' };
  await adRunAction(mk({ env, platform: s.p, ltx: ACTIVE }).d, collect());
  assert.equal(got, 'ext-9');
  const none = await adRunAction(mk({ env, platform: spy(true).p }).d, collect());
  assert.deepEqual([none.status, (await j(none)).code], [409, 'NO_ACTIVE_LAUNCH']);
  const unk = await adRunAction(mk({ env, platform: spy(true).p, ltx: (q) => (q.includes('ad_launch_active') ? [{ r: { state: 'unknown', external_id: null, request_key: KEY, amount_krw: 1000 } }] : launchDefault(q)) }).d, collect());
  assert.equal((await j(unk)).code, 'LAUNCH_UNKNOWN');
});
