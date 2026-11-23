// PM 11/22 P1 광고비 초과 위험 OS1~OS5 — 같은 재현 시나리오를 유지하고, 수정 후 기대값(초과 불가·UNKNOWN·fail-closed)으로 검증한다.
// 가짜 Google transport만. 실계정·실접속·과금·유료 API 없음. 계정 합산 DB 한도는 db/tests/99_ad_overspend_repro.sql(0020)에서 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleAdsPlatform } from '../../src/server/advertising/googleAdsPlatform';
import { callPlatform, platformDailyBudgetFor, type AdPlatform } from '../../src/server/advertising/platform';
import { adRunAction } from '../../src/server/admin/adRun';
import { judgeAccountSpend, judgeSpend } from '../../src/server/advertising/budgetGuard';
import { AD_DAILY_CAP_KRW, AD_FIRST3DAYS_CAP_KRW } from '../../src/server/advertising/campaignDraft';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';import { approvedKeywords, approvedRsaCreative } from '../../src/server/advertising/googleAdsCreative';


const CID = '1234567890';
const enc = (s: string) => new TextEncoder().encode(s);
const stream = (t: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(t)); c.close(); } });
const GOOGLE_MAX_DAY_MULTIPLIER = 2; // Google 도움말: 특정일 평균 일예산의 최대 2배(월 30.4배 이내)

/** 가짜 Google 계정: 예산·캠페인·상태를 기억하고, 하루 지출은 '일예산 × 배수'로 흉내 낸다(Google 2배 규칙의 최악값) */
function fakeAccount(o: { pauseFails?: 'http500' | 'throw'; reportRows?: boolean; externalActive?: number; listFails?: boolean } = {}) {
  const budgets = new Map<string, number>(); const camps = new Map<string, { budget: string; status: string; end?: string }>();
  let n = 100;
  const t: BodyTransport = async (url, init) => {
    const ok = (j: unknown) => ({ status: 200, body: stream(JSON.stringify(j)) });
    if (url.endsWith('/token')) return ok({ access_token: 'ya29.fake_access_token_0000000000' });
    const body = init.body ? JSON.parse(new TextDecoder().decode(init.body)) : {};
    if (url.endsWith('campaignBudgets:mutate')) { const id = `customers/${CID}/campaignBudgets/${++n}`; budgets.set(id, Number(body.operations[0].create.amountMicros) / 1e6); return ok({ results: [{ resourceName: id }] }); }
    if (url.endsWith('campaigns:mutate')) {
      const op = body.operations[0];
      if (op.create) { const id = `customers/${CID}/campaigns/${++n}`; camps.set(id, { budget: op.create.campaignBudget, status: op.create.status, end: op.create.endDateTime }); return ok({ results: [{ resourceName: id }] }); }
      if (o.pauseFails === 'throw') throw new Error('ECONNRESET');
      if (o.pauseFails === 'http500') return { status: 500, body: stream('{}') };
      camps.get(op.update.resourceName)!.status = 'PAUSED'; return ok({ results: [{ resourceName: op.update.resourceName }] });
    }
    // 11/23 C: 광고 그룹·반응형 검색광고(항상 PAUSED)
    if (url.endsWith('adGroups:mutate')) return ok({ results: [{ resourceName: `customers/${CID}/adGroups/${++n}` }] });
    if (url.endsWith('adGroupCriteria:mutate')) return ok({ results: body.operations.map(() => ({ resourceName: `customers/${CID}/adGroupCriteria/${n}~${++n}` })) });
    if (url.endsWith('adGroupAds:mutate')) return ok({ results: [{ resourceName: `customers/${CID}/adGroupAds/${n}~${++n}` }] });
    if (url.endsWith('googleAds:search')) {
      const q: string = body.query;
      if (/FROM ad_group_criterion/.test(q)) return ok({ results: approvedKeywords()!.map((k) => ({ adGroupCriterion: { status: 'PAUSED', keyword: { text: k.text, matchType: 'EXACT' } } })) });
      if (/FROM ad_group_ad/.test(q)) { const c = camps.get(`customers/${CID}/campaigns/${q.match(/campaign\.id = (\d+)/)?.[1]}`); return ok({ results: [{ campaign: { status: c?.status }, adGroup: { status: 'PAUSED' }, adGroupAd: { status: 'PAUSED' } }] }); }
      if (/FROM customer$/.test(q)) return ok({ results: [{ customer: { timeZone: 'Asia/Seoul' } }] });
      if (/campaign\.status = 'ENABLED'/.test(q)) {
        if (o.listFails) return { status: 500, body: stream('{}') };
        const mine = [...camps.values()].filter((c) => c.status === 'ENABLED').length;
        return ok({ results: Array.from({ length: mine + (o.externalActive ?? 0) }, (_, i) => ({ campaign: { id: String(9000 + i) } })) });
      } const id = q.match(/campaign\.id = (\d+)/)?.[1];
      const c = camps.get(`customers/${CID}/campaigns/${id}`);
      if (/amount_micros/.test(q)) return ok({ results: [{ campaignBudget: { amountMicros: String(budgets.get(c!.budget)! * 1e6) }, campaign: { endDateTime: c!.end }, customer: { timeZone: 'Asia/Seoul' } }] });
      return ok({ results: o.reportRows === false ? [] : [{ metrics: { impressions: '10', clicks: '1', costMicros: String(budgets.get(c!.budget)! * GOOGLE_MAX_DAY_MULTIPLIER * 1e6) } }] });
    }
    throw new Error('unexpected url');
  };
  const worstDaySpend = () => [...camps.values()].filter((c) => c.status !== 'PAUSED').reduce((s, c) => s + budgets.get(c.budget)! * GOOGLE_MAX_DAY_MULTIPLIER, 0);
  return { t, camps, worstDaySpend };
}
// 실제 집행 구성(initialStatus='ENABLED')을 흉내 낸다. 기본값 PAUSED면 소재·노출이 없어 지출 0(OS0)
const plat = (t: BodyTransport, initialStatus: 'ENABLED' | 'PAUSED' = 'ENABLED') => createGoogleAdsPlatform({ transport: t, clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt', customerId: CID, initialStatus, creative: approvedRsaCreative(), keywords: approvedKeywords(), landingUrl: 'https://example.com/internet-tv' })!;
// 서버(adRun)와 같은 규칙: 매체 일예산 = 승인액 ÷ 2
const launch = (p: ReturnType<typeof plat>, campaign: string, krw: number, k: string) =>
  callPlatform((deadlineAt) => p.launch({ campaign, amountKrw: krw, requestKey: k, platformDailyBudgetKrw: platformDailyBudgetFor(krw), endDate: '2026-12-03', deadlineAt }));

test('OS0 기본 구성(PAUSED 생성)은 지출 0 — 초과 위험은 ENABLED로 집행할 때 생긴다', async () => {
  const a = fakeAccount();
  assert.equal((await launch(plat(a.t, 'PAUSED'), 'camp-os', AD_DAILY_CAP_KRW, 'req-os-000000000000')).status, 'success');
  assert.equal(a.worstDaySpend(), 0);
});
test('OS1 수정: 매체 일예산 = 승인액 ÷ 2 → Google 2배 지출이 나가도 하루 최악 1만원(승인 일 한도 이하), 승인액 그대로 설정은 전송 전 거부', async () => {
  const a = fakeAccount();
  const r = await launch(plat(a.t), 'camp-os', AD_DAILY_CAP_KRW, 'req-os-000000000001');
  assert.equal(r.status, 'success');
  assert.equal(r.status === 'success' && r.value.dailyBudgetKrw, 5_000);
  assert.equal(r.status === 'success' && r.value.endVerified, true, '매체 종료일·시간대 read-back 확인');
  assert.equal(a.worstDaySpend(), 10_000);
  assert.ok(a.worstDaySpend() <= AD_DAILY_CAP_KRW);
  const b = fakeAccount();
  const bad = await callPlatform((deadlineAt) => plat(b.t).launch({ campaign: 'camp-os', amountKrw: 10_000, requestKey: 'req-os-000000000009', platformDailyBudgetKrw: 10_000, endDate: '2026-12-03', deadlineAt }));
  assert.deepEqual(bad, { status: 'failed', code: 'BUDGET_INVALID' });
  assert.equal(b.camps.size, 0);
  // 3일 최악: 하루 1만 × 3 = 3만 ≤ 누적 3만
  assert.ok(a.worstDaySpend() * 3 <= AD_FIRST3DAYS_CAP_KRW);
});
test('OS2 수정: 두 번째 캠페인 집행은 계정에 노출 가능 캠페인이 있으면 차단(외부 생성 포함), 조회 실패도 차단 — 계정 하루 최악 1만 유지', async () => {
  const a = fakeAccount(); const p = plat(a.t);
  assert.equal((await launch(p, 'camp-os-a', 10_000, 'req-os-a-0000000001')).status, 'success');
  assert.equal(await callPlatform((deadlineAt) => p.activeCampaignCount({ deadlineAt })).then((r) => r.status === 'success' && r.value), 1);
  // 서버 집행 경로: 외부 활성 캠페인 확인이 DB·플랫폼 launch보다 먼저
  const calls: string[] = [];
  const env = { ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01', AD_EXECUTION_ENABLED: 'true' };
  const runWith = async (pl: AdPlatform) => adRunAction({
    platform: pl, env: () => env, mode: () => 'supabase', now: () => new Date('2026-12-01T03:00:00Z'),
    requireStaff: async () => ({ actor: '00000000-0000-4000-8000-000000000001', session: '10000000-0000-4000-8000-000000000001', token: 't', role: 'owner' }),
    runInTransaction: async () => { calls.push('db'); return [{ r: { ok: true } }]; },
  } as never, { action: 'launch', campaign: 'camp-os-b', amountKrw: 10_000, requestKey: 'req-os-b-0000000001' });
  const wrap = (base: ReturnType<typeof plat>): AdPlatform => ({ ...base, async launch(req) { calls.push('launch'); return base.launch(req); } });
  const r1 = await runWith(wrap(p));
  assert.deepEqual([r1.status, (await r1.json()).reason], [409, 'EXTERNAL_ACTIVE_CAMPAIGN']);
  const ext = fakeAccount({ externalActive: 1 });
  const r2 = await runWith(wrap(plat(ext.t)));
  assert.deepEqual([r2.status, (await r2.json()).reason], [409, 'EXTERNAL_ACTIVE_CAMPAIGN']);
  const down = fakeAccount({ listFails: true });
  const r3 = await runWith(wrap(plat(down.t)));
  assert.deepEqual([r3.status, (await r3.json()).reason], [503, 'EXTERNAL_CHECK_FAILED']);
  assert.deepEqual(calls, [], 'DB·플랫폼 launch 호출 0회');
  assert.equal(a.worstDaySpend(), 10_000);
});
test('OS3 수정: 감시는 계정 합산으로 판정 — 두 캠페인 각 5천(합 1만)이면 STOP_REQUIRED, 한쪽 보고 없음이면 UNKNOWN → STOP_REQUIRED', () => {
  const d1 = judgeSpend({ dailyCapKrw: AD_DAILY_CAP_KRW, totalCapKrw: AD_FIRST3DAYS_CAP_KRW, days: [{ date: '2026-12-01', spendKrw: 20_000 }] });
  assert.ok(d1.ok && d1.action === 'STOP_REQUIRED' && d1.reasons.includes('DAILY_CAP_REACHED'));
  const acc = judgeAccountSpend([{ campaign: 'camp-os-a', days: [{ date: '2026-12-01', spendKrw: 5_000 }] }, { campaign: 'camp-os-b', days: [{ date: '2026-12-01', spendKrw: 5_000 }] }]);
  assert.ok(acc.ok && acc.action === 'STOP_REQUIRED' && acc.totalSpendKrw === 10_000 && acc.reasons.includes('DAILY_CAP_REACHED'));
  const lag = judgeAccountSpend([{ campaign: 'camp-os-a', days: [{ date: '2026-12-01', spendKrw: 1_000 }] }, { campaign: 'camp-os-b', days: [{ date: '2026-12-01', spendKrw: null }] }]);
  assert.ok(lag.ok && lag.action === 'STOP_REQUIRED' && lag.reasons.includes('UNKNOWN_SPEND') && lag.totalSpendKrw === null);
  const three = judgeAccountSpend([{ campaign: 'camp-os-a', days: [{ date: '2026-12-01', spendKrw: 9_000 }, { date: '2026-12-02', spendKrw: 9_000 }] }, { campaign: 'camp-os-b', days: [{ date: '2026-12-03', spendKrw: 9_000 }] }]);
  assert.ok(three.ok && three.totalSpendKrw === 27_000 && three.action === 'WARN');
  for (const bad of [[], null, [{ campaign: 'a', days: [] }], [{ campaign: 'a', days: [{ date: '2026-12-01', spendKrw: 1 }] }, { campaign: 'a', days: [{ date: '2026-12-01', spendKrw: 1 }] }]]) assert.deepEqual(judgeAccountSpend(bad), { ok: false, error: 'INVALID_INPUT' });
});
test('OS4 수정: 중지 API 장애(500·연결 끊김) → 중지 실패로 끝나고(fail-closed), 그 상태에서 새 집행은 외부 활성 캠페인 확인에서 차단', async () => {
  for (const f of ['http500', 'throw'] as const) {
    const a = fakeAccount({ pauseFails: f }); const p = plat(a.t);
    const r = await launch(p, 'camp-os', 10_000, 'req-os-000000000002');
    const ext = r.status === 'success' ? r.value.externalId : '';
    const s = await callPlatform((deadlineAt) => p.pause({ campaign: 'camp-os', externalId: ext }, { deadlineAt }));
    assert.notEqual(s.status, 'success');
    // 플랫폼 일예산 상한(승인액 ÷ 2) 덕에 계속 노출돼도 하루 최악 1만 이하
    assert.equal(a.worstDaySpend(), 10_000);
    const c = await callPlatform((deadlineAt) => p.activeCampaignCount({ deadlineAt }));
    assert.ok(c.status === 'success' && c.value === 1, '아직 노출 중인 캠페인이 보이므로 새 launch는 EXTERNAL_ACTIVE_CAMPAIGN으로 차단');
  }
  // 서버 쪽 fail-closed(중지 실패 경고 열림 → 계정 전체 지출 STOP_PENDING)는 DB 시험 OS-DB7·95 W3c에서 검증
});
test('OS5 수정: 보고 지연(성과 행 없음)이면 광고비 0이 아니라 UNKNOWN(null) → 서버는 기록하지 않고 SPEND_UNKNOWN', async () => {
  const a = fakeAccount({ reportRows: false }); const p = plat(a.t);
  const r = await launch(p, 'camp-os', 10_000, 'req-os-000000000003');
  const ext = r.status === 'success' ? r.value.externalId : '';
  const perf = await callPlatform((deadlineAt) => p.fetchPerformance({ campaign: 'camp-os', externalId: ext }, '2026-12-01', { deadlineAt }));
  assert.equal(perf.status, 'success');
  assert.deepEqual(perf.status === 'success' && perf.value, { impressions: null, clicks: null, costKrw: null });
  const db: string[] = [];
  const res = await adRunAction({
    platform: { ...p, live: false, fetchPerformance: (ref, day, o) => p.fetchPerformance({ ...ref, externalId: ext }, day, o) } as AdPlatform, env: () => ({ ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' }), mode: () => 'supabase', now: () => new Date('2026-12-01T03:00:00Z'),
    requireStaff: async () => ({ actor: '00000000-0000-4000-8000-000000000001', session: '10000000-0000-4000-8000-000000000001', token: 't', role: 'owner' }),
    runInTransaction: async () => { db.push('db'); return [{ r: null }]; },
  } as never, { action: 'collect', campaign: 'camp-os', day: '2026-12-01' });
  assert.deepEqual([res.status, await res.json()], [202, { ok: false, recorded: false, spend: 'UNKNOWN', reason: 'SPEND_UNKNOWN' }]);
});
