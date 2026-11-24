// 실계정 읽기 전용 점검(scripts/google-ads-probe/liveread.ts) — 가짜 응답만. 실제 Google 호출 0회.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runLiveRead, recommendCpc, capPlan, CANDIDATE_KEYWORDS } from '../../scripts/google-ads-probe/liveread';
import type { ProbeLine } from '../../scripts/google-ads-probe/core';

const SECRET = 'refresh-' + 'Q'.repeat(30);
const ENV = { GOOGLE_ADS_CLIENT_ID: 'cid.apps.example', GOOGLE_ADS_CLIENT_SECRET: 'sec-' + 'R'.repeat(20), GOOGLE_ADS_REFRESH_TOKEN: SECRET, GOOGLE_ADS_CUSTOMER_ID: '123-456-7890' };
type Mode = { campaigns?: unknown[]; daily?: unknown[]; total?: unknown[]; status?: number; ideas?: unknown[]; kwStatus?: number };
function fake(mode: Mode = {}) {
  const calls: { url: string; body: string }[] = [];
  const t = async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    if (url.includes('oauth2')) return { status: 200, text: JSON.stringify({ access_token: 'tok-' + 'Z'.repeat(20) }) };
    if (url.endsWith(':generateKeywordHistoricalMetrics')) return mode.kwStatus ? { status: mode.kwStatus, text: '{}' } : { status: 200, text: JSON.stringify({ results: mode.ideas ?? [] }) };
    if (mode.status && mode.status !== 200) return { status: mode.status, text: JSON.stringify({ error: { details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } }) };
    const q = String(JSON.parse(init.body).query);
    const rows = q.includes('FROM customer WHERE') ? mode.total ?? [] : q.includes('segments.date') ? mode.daily ?? [] : q.includes('FROM campaign') ? mode.campaigns ?? []
      : [{ customer: { currencyCode: 'KRW', timeZone: 'Asia/Seoul', testAccount: false, manager: false, status: 'ENABLED' } }];
    return { status: 200, text: JSON.stringify({ results: rows }) };
  };
  return { t, calls };
}
const run = async (mode: Mode, env: Record<string, string> = ENV) => { const f = fake(mode); const lines: ProbeLine[] = []; const code = await runLiveRead(env, f.t, (l) => lines.push(l)); return { code, lines, calls: f.calls, out: JSON.stringify(lines) }; };
const day = (date: string, id: string, imp: number, clk: number, micros: number, conv: number) => ({ segments: { date }, campaign: { id }, metrics: { impressions: String(imp), clicks: String(clk), costMicros: String(micros), conversions: conv } });

test('GL1 읽기만: 허용 주소 3곳(토큰·search·generateKeywordHistoricalMetrics) 밖·mutate 본문은 보내지 않음, 변경 호출 0회', async () => {
  const r = await run({ campaigns: [{ campaign: { id: '1', status: 'PAUSED', biddingStrategyType: 'MANUAL_CPC' }, campaignBudget: { amountMicros: '3000000000' } }] });
  assert.equal(r.code, 0);
  for (const c of r.calls) assert.ok(/oauth2\.googleapis\.com\/token$|\/googleAds:search$|:generateKeywordHistoricalMetrics$/.test(c.url) && !/mutate|validateOnly/i.test(c.body), c.url);
  assert.ok(!r.calls.some((c) => /mutate/.test(c.url)));
  const src = readFileSync('scripts/google-ads-probe/liveread.ts', 'utf8');
  assert.ok(!/:mutate|validateOnly: true|\.pause\(|\.launch\(/.test(src), '변경 코드 없음');
});

test('GL2 실적 0: 0 그대로 보고(추정 없음), PAUSED 유지 보고, 민감정보(토큰·고객 ID·캠페인 ID) 출력 없음', async () => {
  const r = await run({ campaigns: [{ campaign: { id: '98765', status: 'PAUSED' }, campaignBudget: { amountMicros: '3000000000' } }] });
  const m = r.lines.find((l) => l.step === 'metrics_30d')!;
  assert.deepEqual([m.impressions, m.clicks, m.costKrw, m.conversions, m.ok], [0, 0, 0, 0, true]);
  const c = r.lines.find((l) => l.step === 'campaigns')!;
  assert.deepEqual([c.paused, c.enabled, c.dailyBudgetsKrw], [1, 0, ['3000']]);
  for (const s of [SECRET, 'tok-ZZZ', '1234567890', '123-456-7890', '98765', ENV.GOOGLE_ADS_CLIENT_SECRET]) assert.ok(!r.out.includes(s), s);
});

test('GL3 일별 중복·합계 불일치 감지(종료 6), 정상 대조는 합계 일치', async () => {
  const daily = [day('2026-11-20', '1', 10, 2, 1_500_000_000, 1), day('2026-11-21', '1', 5, 1, 700_000_000, 0)];
  const ok = await run({ daily, total: [{ metrics: { impressions: '15', clicks: '3', costMicros: '2200000000', conversions: 1 } }] });
  const m = ok.lines.find((l) => l.step === 'metrics_30d')!;
  assert.deepEqual([ok.code, m.totalsMatch, m.duplicateRows, m.costKrw, m.firstDate, m.lastDate], [0, true, 0, 2200, '2026-11-20', '2026-11-21']);
  const dup = await run({ daily: [...daily, daily[0]], total: [{ metrics: { impressions: '15', clicks: '3', costMicros: '2200000000', conversions: 1 } }] });
  assert.equal(dup.code, 6);
  const mis = await run({ daily, total: [{ metrics: { impressions: '16', clicks: '3', costMicros: '2200000000', conversions: 1 } }] });
  assert.equal(mis.code, 6);
});

test('GL4 ENABLED 캠페인이 있으면 바꾸지 않고 보고(종료 5)·집행 차단 표시, 권한 오류는 안전 종료(3)·오류코드만', async () => {
  const en = await run({ campaigns: [{ campaign: { id: '1', status: 'ENABLED' } }] });
  assert.equal(en.code, 5);
  assert.equal(en.lines.find((l) => l.step === 'cap')!.launchBlocked, true);
  const denied = await run({ status: 403 });
  assert.equal(denied.code, 3);
  assert.ok(denied.out.includes('authorizationError.USER_PERMISSION_DENIED') && !denied.out.includes(SECRET));
});

test('GL5 권장 CPC = 페이지 상단 하한(10원 올림), 하한 없으면 null(추정 금지), 월 한도 없으면 집행 차단', async () => {
  assert.equal(recommendCpc(1_234_000_000), 1240); assert.equal(recommendCpc(null), null); assert.equal(recommendCpc(0), null);
  assert.deepEqual(capPlan(100_000, 1240), { dailyBudgetKrw: 3289, maxClicksPerMonth: 80 });
  assert.equal(capPlan(null, 1240), null); assert.equal(capPlan(500, 1240), null);
  const ideas = [{ text: '인터넷 TV 약정 만료', closeVariants: ['인터넷 TV 약정 만료'], keywordMetrics: { avgMonthlySearches: '1300', competition: 'HIGH', lowTopOfPageBidMicros: '1234000000', highTopOfPageBidMicros: '5000000000', averageCpcMicros: '2100000000' } }];
  const noCap = await run({ ideas });
  const k = noCap.lines.find((l) => l.step === 'keyword_cpc' && l.keyword === CANDIDATE_KEYWORDS[0])!;
  assert.deepEqual([k.match, k.recommendedCpcKrw, k.lowTopBidKrw, k.highTopBidKrw, k.avgCpcKrw, k.avgMonthlySearches, k.maxClicksPerMonthAtCap], ['EXACT', 1240, 1234, 5000, 2100, 1300, null]);
  assert.equal(noCap.lines.find((l) => l.keyword === CANDIDATE_KEYWORDS[1])!.recommendedCpcKrw, null, '데이터 없는 키워드는 null');
  assert.equal(noCap.lines.find((l) => l.step === 'cap')!.launchBlocked, true, '월 한도 미설정 = 집행 차단');
  const withCap = await run({ ideas }, { ...ENV, GOOGLE_ADS_MONTHLY_CAP_KRW: '100000' });
  assert.deepEqual([withCap.lines.find((l) => l.step === 'cap')!.dailyBudgetKrw, withCap.lines.find((l) => l.keyword === CANDIDATE_KEYWORDS[0])!.maxClicksPerMonthAtCap], [3289, 80]);
});

test('GL6 키워드 10개 = PM 승인 후보(인터넷+TV), 요청은 GenerateKeywordHistoricalMetrics 한 번(10개·한국어·한국·구글 검색), 아이디어 요청 없음', async () => {
  assert.deepEqual([...CANDIDATE_KEYWORDS], ['인터넷 TV 약정 만료', '인터넷 TV 약정 끝나면', '인터넷 TV 재약정', '약정 만료 인터넷 TV 변경', '이사 인터넷 TV 설치', '이사 인터넷 TV 이전', '전입 인터넷 TV 신청', '새집 인터넷 TV', '인터넷 TV 통신사 변경', '인터넷 TV 갈아타기']);
  const r = await run({});
  const kw = r.calls.filter((c) => c.url.includes(':generateKeyword'));
  assert.equal(kw.length, 1);
  assert.ok(kw[0]!.url.endsWith('/v26/customers/1234567890:generateKeywordHistoricalMetrics'));
  assert.deepEqual(JSON.parse(kw[0]!.body), { keywords: [...CANDIDATE_KEYWORDS], language: 'languageConstants/1012', geoTargetConstants: ['geoTargetConstants/2410'], keywordPlanNetwork: 'GOOGLE_SEARCH', historicalMetricsOptions: { includeAverageCpc: true } });
  assert.equal(r.lines.filter((l) => l.step === 'keyword_cpc').length, 10, '10개 모두 한 줄씩 보고');
});

test('GL7 합쳐진·누락 키워드는 추측하지 않고 따로 표시: MERGED(다른 결과에 합쳐짐)·COMBINED(다른 후보와 합산)·MISSING(결과 없음) — 권장 CPC null', async () => {
  const M = (low: string) => ({ avgMonthlySearches: '90', competition: 'LOW', lowTopOfPageBidMicros: low, highTopOfPageBidMicros: '900000000' });
  const ideas = [
    { text: '인터넷 TV 약정 만료', closeVariants: ['인터넷 TV 약정 만료', '인터넷 TV 약정 끝나면'], keywordMetrics: M('300000000') },
    { text: '이사 인터넷 TV 설치', closeVariants: ['이사 인터넷 TV 설치'], keywordMetrics: M('500000000') },
  ];
  const r = await run({ ideas });
  const L = (k: string) => r.lines.find((l) => l.step === 'keyword_cpc' && l.keyword === k)!;
  assert.deepEqual([L('인터넷 TV 약정 만료').match, L('인터넷 TV 약정 만료').combinedWith, L('인터넷 TV 약정 만료').recommendedCpcKrw, L('인터넷 TV 약정 만료').avgMonthlySearches], ['COMBINED', ['인터넷 TV 약정 끝나면'], null, 90]);
  assert.deepEqual([L('인터넷 TV 약정 끝나면').match, L('인터넷 TV 약정 끝나면').mergedInto, L('인터넷 TV 약정 끝나면').avgMonthlySearches, L('인터넷 TV 약정 끝나면').recommendedCpcKrw], ['MERGED', '인터넷 TV 약정 만료', null, null], '합쳐진 키워드에 대표 수치를 옮겨 적지 않음');
  assert.deepEqual([L('이사 인터넷 TV 설치').match, L('이사 인터넷 TV 설치').recommendedCpcKrw], ['EXACT', 500]);
  assert.deepEqual([L('새집 인터넷 TV').match, L('새집 인터넷 TV').avgMonthlySearches, L('새집 인터넷 TV').lowTopBidKrw, L('새집 인터넷 TV').ok], ['MISSING', null, null, false]);
  assert.equal(r.lines.filter((l) => l.step === 'keyword_cpc' && l.match === 'MISSING').length, 7);
});

test('GL8 키워드 조회 실패(권한 없음 403·서버 오류)는 오류 코드만 한 줄, 수치 추측 없음, 다른 단계 결과는 그대로', async () => {
  for (const kwStatus of [403, 500]) {
    const r = await run({ kwStatus });
    const k = r.lines.filter((l) => l.step === 'keyword_cpc');
    assert.equal(k.length, 1);
    assert.deepEqual([k[0]!.ok, k[0]!.http], [false, kwStatus]);
    assert.ok(r.lines.some((l) => l.step === 'metrics_30d' && l.ok === true));
  }
});

test('GL9 Mac mini 단일 파일(.mjs)도 같은 키워드·같은 주소·같은 읽기 전용 제한(원본 liveread.ts와 일치)', () => {
  const mjs = readFileSync('scripts/google-ads-probe/google-ads-liveread.mjs', 'utf8');
  const ts = readFileSync('scripts/google-ads-probe/liveread.ts', 'utf8');
  const kwOf = (s: string) => s.match(/CANDIDATE_KEYWORDS = Object\.freeze\((\[[^\]]+\])\)/)![1];
  assert.equal(kwOf(mjs), kwOf(ts));
  for (const s of [mjs, ts]) {
    assert.ok(s.includes('`${base}:generateKeywordHistoricalMetrics`]') && !s.includes('generateKeywordIdeas'));
    assert.ok(s.includes("!/mutate|validateOnly/i.test(init.body)"));
    assert.ok(!/:mutate|validateOnly: true/.test(s));
  }
});
