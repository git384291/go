// PM 11/22 P1 광고비 초과 위험 재현(현재 동작 기록 — 수정 아님). 가짜 Google transport만. 실계정·실접속·과금·유료 API 없음.
// 각 시험은 '지금 코드가 이렇게 동작한다'를 고정한다. 수정 승인 뒤에는 기대값을 수정안에 맞게 바꾼다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleAdsPlatform } from '../../src/server/advertising/googleAdsPlatform';
import { callPlatform } from '../../src/server/advertising/platform';
import { judgeSpend } from '../../src/server/advertising/budgetGuard';
import { AD_DAILY_CAP_KRW, AD_FIRST3DAYS_CAP_KRW } from '../../src/server/advertising/campaignDraft';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const CID = '1234567890';
const enc = (s: string) => new TextEncoder().encode(s);
const stream = (t: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(t)); c.close(); } });
const GOOGLE_MAX_DAY_MULTIPLIER = 2; // Google 도움말: 특정일 평균 일예산의 최대 2배(월 30.4배 이내)

/** 가짜 Google 계정: 예산·캠페인·상태를 기억하고, 하루 지출은 '일예산 × 배수'로 흉내 낸다(Google 2배 규칙의 최악값) */
function fakeAccount(o: { pauseFails?: 'http500' | 'throw'; reportRows?: boolean } = {}) {
  const budgets = new Map<string, number>(); const camps = new Map<string, { budget: string; status: string }>();
  let n = 100;
  const t: BodyTransport = async (url, init) => {
    const ok = (j: unknown) => ({ status: 200, body: stream(JSON.stringify(j)) });
    if (url.endsWith('/token')) return ok({ access_token: 'ya29.fake_access_token_0000000000' });
    const body = init.body ? JSON.parse(new TextDecoder().decode(init.body)) : {};
    if (url.endsWith('campaignBudgets:mutate')) { const id = `customers/${CID}/campaignBudgets/${++n}`; budgets.set(id, Number(body.operations[0].create.amountMicros) / 1e6); return ok({ results: [{ resourceName: id }] }); }
    if (url.endsWith('campaigns:mutate')) {
      const op = body.operations[0];
      if (op.create) { const id = `customers/${CID}/campaigns/${++n}`; camps.set(id, { budget: op.create.campaignBudget, status: op.create.status }); return ok({ results: [{ resourceName: id }] }); }
      if (o.pauseFails === 'throw') throw new Error('ECONNRESET');
      if (o.pauseFails === 'http500') return { status: 500, body: stream('{}') };
      camps.get(op.update.resourceName)!.status = 'PAUSED'; return ok({ results: [{ resourceName: op.update.resourceName }] });
    }
    if (url.endsWith('googleAds:search')) {
      const q: string = body.query; const id = q.match(/campaign\.id = (\d+)/)?.[1];
      const c = camps.get(`customers/${CID}/campaigns/${id}`);
      if (/amount_micros/.test(q)) return ok({ results: [{ campaignBudget: { amountMicros: String(budgets.get(c!.budget)! * 1e6) } }] });
      return ok({ results: o.reportRows === false ? [] : [{ metrics: { impressions: '10', clicks: '1', costMicros: String(budgets.get(c!.budget)! * GOOGLE_MAX_DAY_MULTIPLIER * 1e6) } }] });
    }
    throw new Error('unexpected url');
  };
  const worstDaySpend = () => [...camps.values()].filter((c) => c.status !== 'PAUSED').reduce((s, c) => s + budgets.get(c.budget)! * GOOGLE_MAX_DAY_MULTIPLIER, 0);
  return { t, camps, worstDaySpend };
}
// 실제 집행 구성(initialStatus='ENABLED')을 흉내 낸다. 기본값 PAUSED면 소재·노출이 없어 지출 0(OS0)
const plat = (t: BodyTransport, initialStatus: 'ENABLED' | 'PAUSED' = 'ENABLED') => createGoogleAdsPlatform({ transport: t, clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt', customerId: CID, initialStatus })!;
const launch = (p: ReturnType<typeof plat>, campaign: string, krw: number, k: string) =>
  callPlatform((deadlineAt) => p.launch({ campaign, amountKrw: krw, requestKey: k, platformDailyBudgetKrw: krw, deadlineAt }));

test('OS0 기본 구성(PAUSED 생성)은 지출 0 — 초과 위험은 ENABLED로 집행할 때 생긴다', async () => {
  const a = fakeAccount();
  assert.equal((await launch(plat(a.t, 'PAUSED'), 'camp-os', AD_DAILY_CAP_KRW, 'req-os-000000000000')).status, 'success');
  assert.equal(a.worstDaySpend(), 0);
});
test('OS1 재현: adRun은 매체 일예산 = 승인액(최대 1만원)으로 만든다 → Google 2배 규칙상 하루 최대 2만원(승인 일 한도 초과 가능)', async () => {
  const a = fakeAccount();
  const r = await launch(plat(a.t), 'camp-os', AD_DAILY_CAP_KRW, 'req-os-000000000001');
  assert.equal(r.status, 'success');
  assert.equal(r.status === 'success' && r.value.dailyBudgetKrw, AD_DAILY_CAP_KRW); // read-back 검증도 '≤ 승인액'만 본다 → 통과
  assert.equal(a.worstDaySpend(), 20_000);
  assert.ok(a.worstDaySpend() > AD_DAILY_CAP_KRW);
});
test('OS2 재현: 동시 캠페인 2개(각각 승인 1만) → 계정 하루 최악 4만원. 어댑터·DB 모두 계정 합산 검사 없음(DB는 99_ad_overspend_repro.sql)', async () => {
  const a = fakeAccount(); const p = plat(a.t);
  assert.equal((await launch(p, 'camp-os-a', 10_000, 'req-os-a-0000000001')).status, 'success');
  assert.equal((await launch(p, 'camp-os-b', 10_000, 'req-os-b-0000000001')).status, 'success');
  assert.equal(a.worstDaySpend(), 40_000);
});
test('OS3 재현: 감시는 사후 판정 — 보고값 2만원이 들어온 뒤에야 STOP_REQUIRED, 2일 연속 2만원이면 누적 3만 한도도 넘은 뒤 판정', () => {
  const d1 = judgeSpend({ dailyCapKrw: AD_DAILY_CAP_KRW, totalCapKrw: AD_FIRST3DAYS_CAP_KRW, days: [{ date: '2026-12-01', spendKrw: 20_000 }] });
  assert.ok(d1.ok && d1.action === 'STOP_REQUIRED' && d1.reasons.includes('DAILY_CAP_REACHED'));
  const d2 = judgeSpend({ dailyCapKrw: AD_DAILY_CAP_KRW, totalCapKrw: AD_FIRST3DAYS_CAP_KRW, days: [{ date: '2026-12-01', spendKrw: 20_000 }, { date: '2026-12-02', spendKrw: 20_000 }] });
  assert.ok(d2.ok && d2.totalSpendKrw === 40_000 && d2.reasons.includes('TOTAL_CAP_REACHED'));
});
test('OS4 재현: 중지 API 장애(500·연결 끊김) → 중지 실패(불명/실패)로 끝나고 가짜 계정의 캠페인은 계속 ENABLED(지출 지속)', async () => {
  for (const f of ['http500', 'throw'] as const) {
    const a = fakeAccount({ pauseFails: f }); const p = plat(a.t);
    const r = await launch(p, 'camp-os', 10_000, 'req-os-000000000002');
    const ext = r.status === 'success' ? r.value.externalId : '';
    const s = await callPlatform((deadlineAt) => p.pause({ campaign: 'camp-os', externalId: ext }, { deadlineAt }));
    assert.notEqual(s.status, 'success');
    assert.equal(a.worstDaySpend(), 20_000);
  }
});
test('OS5 재현: 보고 지연(성과 행 없음)이면 광고비 0으로 돌아온다 → 수집이 0원으로 기록해 초과를 못 본다', async () => {
  const a = fakeAccount({ reportRows: false }); const p = plat(a.t);
  const r = await launch(p, 'camp-os', 10_000, 'req-os-000000000003');
  const ext = r.status === 'success' ? r.value.externalId : '';
  const perf = await callPlatform((deadlineAt) => p.fetchPerformance({ campaign: 'camp-os', externalId: ext }, '2026-12-01', { deadlineAt }));
  assert.equal(perf.status, 'success');
  assert.equal(perf.status === 'success' && (perf.value as { costKrw?: number }).costKrw, 0);
});
