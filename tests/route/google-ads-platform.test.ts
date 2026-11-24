// Google Ads 어댑터 계약 시험(PM 11/22) — 가짜 transport만. 실계정·실접속·실집행이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callPlatform, createPlatform, PlatformError } from '../../src/server/advertising/platform';
import { createGoogleAdsPlatform, googleAdsConfigFromEnv, GOOGLE_ADS_ENV_NAMES, GOOGLE_ADS_OPTIONAL_ENV_NAMES, type GoogleAdsConfig } from '../../src/server/advertising/googleAdsPlatform';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';
import { candidateKeywords, approvedRsaCreative } from '../../src/server/advertising/googleAdsCreative';

const ACCESS = 'ya29.fake_access_token_for_tests_0000';
const SECRETS = ['dev-token-SECRET', 'client-id-SECRET', 'client-secret-SECRET', 'refresh-SECRET', ACCESS];
const CID = '1234567890';
const KEY = 'req-0123456789abcdef';
const enc = (s: string) => new TextEncoder().encode(s);
type Resp = { status: number; text?: string; throws?: boolean; hang?: boolean };
type Call = { url: string; body: string; headers: Record<string, string> };
const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(text)); c.close(); } });
/** 경로 끝(token·campaignBudgets:mutate·campaigns:mutate·search)별 응답 */
const fake = (script: Partial<Record<'token' | 'budget' | 'campaign' | 'adGroup' | 'kw' | 'ad' | 'status' | 'kwstatus' | 'search', Resp>>) => {
  const calls: Call[] = [];
  const t: BodyTransport = async (url, init) => {
    const body = init.body ? new TextDecoder().decode(init.body) : '';
    const key = url.endsWith('/token') ? 'token' : url.endsWith('campaignBudgets:mutate') ? 'budget' : url.endsWith('campaigns:mutate') ? 'campaign'
      : url.endsWith('adGroups:mutate') ? 'adGroup' : url.endsWith('adGroupCriteria:mutate') ? 'kw' : url.endsWith('adGroupAds:mutate') ? 'ad'
      : url.endsWith('googleAds:search') ? (body.includes('FROM ad_group_criterion') ? 'kwstatus' : body.includes('FROM ad_group_ad') ? 'status' : 'search') : null;
    calls.push({ url, body: init.body ? new TextDecoder().decode(init.body) : '', headers: init.headers });
    if (!key) throw new Error('unexpected url');
    const r = script[key] ?? DEFAULTS[key] ?? { status: 200, text: '{}' };
    if (r.hang) await new Promise(() => undefined);
    if (r.throws) throw new Error('ECONNRESET dev-token-SECRET');
    return { status: r.status, body: stream(r.text ?? '') };
  };
  return { t, calls };
};
const OK_GROUP: Resp = { status: 200, text: JSON.stringify({ results: [{ resourceName: 'customers/1234567890/adGroups/555' }] }) };
const OK_AD: Resp = { status: 200, text: JSON.stringify({ results: [{ resourceName: 'customers/1234567890/adGroupAds/555~999' }] }) };
const statusRow = (c = 'PAUSED', g = 'PAUSED', a = 'PAUSED'): Resp => ({ status: 200, text: JSON.stringify({ results: [{ campaign: { status: c }, adGroup: { status: g }, adGroupAd: { status: a } }] }) });
const KWS = candidateKeywords()!;
const okKw = (cid: string): { status: number; text: string } => ({ status: 200, text: JSON.stringify({ results: KWS.map((_, i) => ({ resourceName: `customers/${cid}/adGroupCriteria/555~${100 + i}` })) }) });
const kwRows = (over: { status?: string; matchType?: string } = {}): { status: number; text: string } => ({ status: 200, text: JSON.stringify({ results: KWS.map((k) => ({ adGroupCriterion: { status: over.status ?? 'PAUSED', keyword: { text: k.text, matchType: over.matchType ?? 'EXACT' } } })) }) });
const DEFAULTS: Partial<Record<string, Resp>> = { adGroup: OK_GROUP, kw: okKw('1234567890'), ad: OK_AD, status: statusRow(), kwstatus: kwRows() };
const LANDING = 'https://example.com/internet-tv';
const OK_TOKEN: Resp = { status: 200, text: JSON.stringify({ access_token: ACCESS }) };
const OK_BUDGET: Resp = { status: 200, text: JSON.stringify({ results: [{ resourceName: `customers/${CID}/campaignBudgets/777` }] }) };
const OK_CAMP: Resp = { status: 200, text: JSON.stringify({ results: [{ resourceName: `customers/${CID}/campaigns/4242` }] }) };
const searchBudget = (micros: string, end = '2026-11-23 23:59:59', tz = 'Asia/Seoul'): Resp => ({ status: 200, text: JSON.stringify({ results: [{ campaignBudget: { amountMicros: micros }, campaign: { endDateTime: end }, customer: { timeZone: tz } }] }) });
const cfg = (t: BodyTransport | null, o: Partial<GoogleAdsConfig> = {}): GoogleAdsConfig => ({
  transport: t, clientId: 'client-id-SECRET', clientSecret: 'client-secret-SECRET', refreshToken: 'refresh-SECRET', customerId: CID, creative: approvedRsaCreative(), keywords: candidateKeywords(), landingUrl: LANDING, ...o,
});
const req = (o: Record<string, unknown> = {}) => ({ campaign: 'camp-a', amountKrw: 5000, requestKey: KEY, platformDailyBudgetKrw: 2500, endDate: '2026-11-23', deadlineAt: Date.now() + 5000, ...o });
const opts = () => ({ deadlineAt: Date.now() + 5000 });
type Plat = ReturnType<typeof createGoogleAdsPlatform>;
const run = async (p: Plat, f: (p: NonNullable<Plat>) => Promise<unknown>) => { try { return { ok: await f(p!) }; } catch (e) { return { err: e as PlatformError }; } };

test('GA1 설정이 하나라도 비면 어댑터 없음(닫힘), transport 0회. createPlatform은 google_ads를 선택하지 않는다', () => {
  const { t, calls } = fake({});
  assert.ok(createGoogleAdsPlatform(cfg(t)));
  for (const bad of [{ creative: null }, { landingUrl: null }, { landingUrl: 'http://example.com/' }, { transport: null }, { apiVersion: 'latest' }, { apiVersion: 'v26.2' }, { apiVersion: '26' }, { clientId: null }, { clientSecret: null }, { refreshToken: null }, { customerId: null }, { customerId: '12-34' }, { loginCustomerId: 'x' }]) assert.equal(createGoogleAdsPlatform({ ...cfg(t), ...bad } as GoogleAdsConfig), null);
  assert.equal(calls.length, 0);
  // developer token·API 버전 미지정은 정상(developer token 불필요, 버전 기본 v26)
  assert.ok(createGoogleAdsPlatform({ ...cfg(t), apiVersion: null, legacyDeveloperToken: null }));
  for (const v of ['google_ads', 'google', 'GOOGLE_ADS']) assert.equal(createPlatform({ AD_PLATFORM: v, AD_EXECUTION_ENABLED: 'true' }), null);
  assert.equal(createGoogleAdsPlatform(cfg(t))!.live, true);
});
test('GA2 환경변수 이름만 참조: 값은 읽어 설정으로 넘길 뿐, 하이픈 제거·빈 값은 null', () => {
  assert.deepEqual([...GOOGLE_ADS_ENV_NAMES], ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID']);
  assert.ok(![...GOOGLE_ADS_ENV_NAMES].some((n) => /DEVELOPER/.test(n)), 'developer token은 필수 credential이 아님');
  assert.deepEqual([...GOOGLE_ADS_OPTIONAL_ENV_NAMES], ['GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'GOOGLE_ADS_API_VERSION', 'GOOGLE_ADS_DEVELOPER_TOKEN']);
  const c = googleAdsConfigFromEnv({ GOOGLE_ADS_CUSTOMER_ID: '123-456-7890', GOOGLE_ADS_DEVELOPER_TOKEN: '  ', GOOGLE_ADS_API_VERSION: 'v26' }, null);
  assert.deepEqual([c.customerId, c.legacyDeveloperToken, c.apiVersion, c.transport], [CID, null, 'v26', null]);
  assert.equal(createGoogleAdsPlatform(c), null);
});
test('GA3 launch 성공: 예산 ≤ 승인 금액(micros), 캠페인·광고 그룹·광고 모두 PAUSED, externalId·read-back 값 반환, 요청 이름에 requestKey', async () => {
  const { t, calls } = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: OK_CAMP, search: searchBudget('2500000000') });
  const p = createGoogleAdsPlatform(cfg(t))!;
  const r = await p.launch(req({ amountKrw: 5000, platformDailyBudgetKrw: 2500 }));
  assert.deepEqual(r, { externalId: '4242', dailyBudgetKrw: 2500, endVerified: true });
  const budget = JSON.parse(calls.find((c) => c.url.endsWith('campaignBudgets:mutate'))!.body);
  assert.equal(budget.operations[0].create.amountMicros, '2500000000');
  assert.ok(Number(budget.operations[0].create.amountMicros) / 1e6 <= 5000);
  const camp = JSON.parse(calls.find((c) => c.url.endsWith('campaigns:mutate'))!.body);
  assert.equal(camp.operations[0].create.status, 'PAUSED');
  assert.ok(String(camp.operations[0].create.name).includes(KEY));
  // 순서: 토큰 → 예산 → 캠페인 → 광고 그룹 → 키워드(1요청) → 광고 → 확인 조회 3회(예산·종료일, 광고 상태, 키워드). 이미지·영상·BROAD·입찰가 없음
  assert.deepEqual(calls.map((c) => c.url.replace(/^.*\//, '')), ['token', 'campaignBudgets:mutate', 'campaigns:mutate', 'adGroups:mutate', 'adGroupCriteria:mutate', 'adGroupAds:mutate', 'googleAds:search', 'googleAds:search', 'googleAds:search']);
  const grp = JSON.parse(calls.find((c) => c.url.endsWith('adGroups:mutate'))!.body).operations[0].create;
  assert.deepEqual([grp.status, grp.type, grp.campaign, 'cpcBidMicros' in grp], ['PAUSED', 'SEARCH_STANDARD', `customers/${CID}/campaigns/4242`, false]);
  const ad = JSON.parse(calls.find((c) => c.url.endsWith('adGroupAds:mutate'))!.body).operations[0].create;
  assert.deepEqual([ad.status, ad.adGroup, ad.ad.finalUrls, ad.ad.finalUrlSuffix], ['PAUSED', `customers/${CID}/adGroups/555`, [LANDING], 'utm_source=google&utm_medium=cpc&utm_campaign=camp-a']);
  assert.ok(ad.ad.responsiveSearchAd.headlines.length >= 3 && ad.ad.responsiveSearchAd.descriptions.length >= 2);
  assert.ok(!/asset|image|video|ENABLED|BROAD|PHRASE|cpcBid/i.test(calls.map((c) => c.body).join('\n')), '이미지·영상·활성화·BROAD·입찰가 요청 없음');
  assert.ok(calls.every((c) => c.url.startsWith('https://googleads.googleapis.com/v26/customers/1234567890/') || c.url === 'https://oauth2.googleapis.com/token'));
  const api = calls.find((c) => c.url.includes('googleads'))!;
  // developer token 없이 동작: 헤더에 developer-token이 없다. legacy 토큰을 주입한 때만 보낸다
  assert.deepEqual([api.headers.authorization, 'developer-token' in api.headers], [`Bearer ${ACCESS}`, false]);
  const lg = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: OK_CAMP, search: searchBudget('2500000000') });
  await createGoogleAdsPlatform(cfg(lg.t, { legacyDeveloperToken: 'dev-token-SECRET' }))!.launch(req({ platformDailyBudgetKrw: 2500 }));
  assert.equal(lg.calls.find((c) => c.url.includes('googleads'))!.headers['developer-token'], 'dev-token-SECRET');
  assert.ok(!calls.some((c) => /pageSize|page_size/.test(c.body)), '검색 요청에 page_size 없음(v26에서 오류)');
});
test('GA4 예산 보호: 상한 초과·비정수·0은 전송 0회 BUDGET_INVALID(failed), read-back 실패·불일치·초과는 dailyBudgetKrw=0(미확인) → 서버가 즉시 중지', async () => {
  const f = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: OK_CAMP });
  const p = createGoogleAdsPlatform(cfg(f.t))!;
  for (const bad of [{ platformDailyBudgetKrw: 5001 }, { platformDailyBudgetKrw: 2501 } /* 2배 지출 시 승인액 초과 */, { platformDailyBudgetKrw: 0 }, { platformDailyBudgetKrw: 10.5 }, { platformDailyBudgetKrw: -1 }, { campaign: 'Bad Campaign' }, { requestKey: 'x' }]) {
    const e = (await run(p, (q) => q.launch(req(bad)))).err!;
    assert.deepEqual([e.outcome, e.code], ['failed', 'BUDGET_INVALID']);
  }
  assert.equal(f.calls.length, 0);
  for (const search of [{ status: 500 }, { status: 200, text: '{}' }, searchBudget('9999000000'), searchBudget('abc'), searchBudget('2500000000'.replace('2', '5000.5')), { status: 200, throws: true }] as Resp[]) {
    const g = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: OK_CAMP, search });
    const r = await createGoogleAdsPlatform(cfg(g.t))!.launch(req({ platformDailyBudgetKrw: 2500 }));
    assert.deepEqual([r.externalId, r.dailyBudgetKrw], ['4242', 0]);
  }
});
test('GA5 오류 구분: 401·403 AUTH_ERROR, 400 BAD_REQUEST, 429 RATE_LIMITED는 failed / 5xx·전송 끊김은 캠페인 단계에서 unknown, 예산 단계는 영향 없어 failed', async () => {
  for (const [status, code] of [[401, 'AUTH_ERROR'], [403, 'AUTH_ERROR'], [400, 'BAD_REQUEST'], [429, 'RATE_LIMITED']] as const) {
    const e = (await run(createGoogleAdsPlatform(cfg(fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: { status } }).t)), (q) => q.launch(req()))).err!;
    assert.deepEqual([e.outcome, e.code], ['failed', code], String(status));
    const b = (await run(createGoogleAdsPlatform(cfg(fake({ token: OK_TOKEN, budget: { status } }).t)), (q) => q.launch(req()))).err!;
    assert.deepEqual([b.outcome, b.code], ['failed', code]);
  }
  for (const campaign of [{ status: 500 }, { status: 503 }, { status: 200, text: 'not json' }, { status: 200, text: '{"results":[]}' }, { status: 200, throws: true }] as Resp[]) {
    const e = (await run(createGoogleAdsPlatform(cfg(fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign }).t)), (q) => q.launch(req()))).err!;
    assert.equal(e.outcome, 'unknown');
  }
  const b5 = (await run(createGoogleAdsPlatform(cfg(fake({ token: OK_TOKEN, budget: { status: 500 } }).t)), (q) => q.launch(req()))).err!;
  assert.equal(b5.outcome, 'failed');
  const tk = (await run(createGoogleAdsPlatform(cfg(fake({ token: { status: 400 } }).t)), (q) => q.launch(req()))).err!;
  assert.deepEqual([tk.outcome, tk.code], ['failed', 'AUTH_ERROR']);
});
test('GA6 시간 초과 → unknown, 서버 callPlatform도 unknown. 자동 재시도 0(요청 수 그대로)', async () => {
  const f = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: { status: 200, hang: true } });
  const p = createGoogleAdsPlatform(cfg(f.t))!;
  const r = await callPlatform((d) => p.launch(req({ deadlineAt: d })), 60);
  assert.deepEqual(r, { status: 'unknown', code: 'TIMEOUT' });
  const n = f.calls.length; await new Promise((res) => setTimeout(res, 100));
  assert.equal(f.calls.length, n);
  assert.equal(f.calls.filter((c) => c.url.endsWith('campaigns:mutate')).length, 1);
  const expired = (await run(p, (q) => q.launch(req({ deadlineAt: Date.now() - 1 })))).err!;
  assert.equal(expired.outcome, 'failed'); // 보내기 전 마감: 아무것도 일어나지 않음
});
test('GA7 pause·성과 조회는 저장된 externalId로: 형식 검증, PAUSED 변경, GAQL은 숫자 ID·날짜 형식만', async () => {
  const f = fake({ token: OK_TOKEN, campaign: OK_CAMP, search: { status: 200, text: JSON.stringify({ results: [{ metrics: { impressions: '1200', clicks: '30', costMicros: '455000000' } }] }) } });
  const p = createGoogleAdsPlatform(cfg(f.t))!;
  assert.deepEqual(await p.pause({ campaign: 'camp-a', externalId: '4242' }, opts()), { paused: true });
  const pb = JSON.parse(f.calls.find((c) => c.url.endsWith('campaigns:mutate'))!.body);
  assert.deepEqual([pb.operations[0].update.resourceName, pb.operations[0].update.status, pb.operations[0].updateMask], [`customers/${CID}/campaigns/4242`, 'PAUSED', 'status']);
  assert.deepEqual(await p.fetchPerformance({ campaign: 'camp-a', externalId: '4242' }, '2026-11-20', opts()), { impressions: 1200, clicks: 30, costKrw: 455 });
  assert.match(JSON.parse(f.calls.find((c) => c.url.endsWith('googleAds:search'))!.body).query, /campaign\.id = 4242 AND segments\.date = '2026-11-20'$/);
  for (const bad of [null, '', "1 OR 1=1", '12a', '1'.repeat(21)]) {
    const e1 = (await run(p, (q) => q.pause({ campaign: 'camp-a', externalId: bad }, opts()))).err!;
    const e2 = (await run(p, (q) => q.fetchPerformance({ campaign: 'camp-a', externalId: bad }, '2026-11-20', opts()))).err!;
    assert.deepEqual([e1.code, e2.code], ['NO_EXTERNAL_ID', 'NO_EXTERNAL_ID']);
  }
  for (const day of ["2026-11-20' OR '1'='1", '11/20', '']) assert.equal((await run(p, (q) => q.fetchPerformance({ campaign: 'camp-a', externalId: '4242' }, day, opts()))).err!.code, 'BAD_REQUEST');
  const empty = fake({ token: OK_TOKEN, search: { status: 200, text: '{"results":[]}' } });
  assert.deepEqual(await createGoogleAdsPlatform(cfg(empty.t))!.fetchPerformance({ campaign: 'camp-a', externalId: '4242' }, '2026-11-20', opts()), { impressions: null, clicks: null, costKrw: null }); // 보고 지연: 0이 아니라 UNKNOWN(PM 11/22 P1 OS5)
  const other = fake({ token: OK_TOKEN, campaign: { status: 200, text: JSON.stringify({ results: [{ resourceName: `customers/${CID}/campaigns/9` }] }) } });
  assert.deepEqual(await createGoogleAdsPlatform(cfg(other.t))!.pause({ campaign: 'camp-a', externalId: '4242' }, opts()), { paused: false });
});
test('GA8 validateOnly: 구글에 검증만 요청, 캠페인 요청 0회, failed(VALIDATE_ONLY)', async () => {
  const f = fake({ token: OK_TOKEN, budget: OK_BUDGET });
  const e = (await run(createGoogleAdsPlatform(cfg(f.t, { validateOnly: true })), (q) => q.launch(req()))).err!;
  assert.deepEqual([e.outcome, e.code], ['failed', 'VALIDATE_ONLY']);
  assert.equal(JSON.parse(f.calls.find((c) => c.url.endsWith('campaignBudgets:mutate'))!.body).validateOnly, true);
  assert.equal(f.calls.filter((c) => c.url.endsWith('campaigns:mutate')).length, 0);
});
test('GA9 비밀 비노출: 오류·결과 어디에도 credential·토큰·URL 없음, initialStatus는 명시해야만 ENABLED', async () => {
  const f = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: { status: 200, throws: true } });
  const out = await callPlatform((d) => createGoogleAdsPlatform(cfg(f.t))!.launch(req({ deadlineAt: d })));
  const s = JSON.stringify(out) + JSON.stringify(await run(createGoogleAdsPlatform(cfg(f.t)), (q) => q.launch(req())));
  for (const x of [...SECRETS, 'googleapis', 'ECONNRESET']) assert.ok(!s.includes(x), x);
  const g = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: OK_CAMP, search: searchBudget('5000000000') });
  await createGoogleAdsPlatform(cfg(g.t, { initialStatus: 'ENABLED' }))!.launch(req());
  assert.equal(JSON.parse(g.calls.find((c) => c.url.endsWith('campaigns:mutate'))!.body).operations[0].create.status, 'ENABLED');
});
test('GA11 API 버전: 기본 major v26, 지정은 major만(v26.2 같은 minor 거부), 모든 요청 URL이 major 경로', async () => {
  const f = fake({ token: OK_TOKEN, campaign: OK_CAMP });
  await createGoogleAdsPlatform(cfg(f.t))!.pause({ campaign: 'camp-a', externalId: '4242' }, opts());
  assert.ok(f.calls.some((c) => c.url === `https://googleads.googleapis.com/v26/customers/${CID}/campaigns:mutate`));
  const g = fake({ token: OK_TOKEN, campaign: OK_CAMP });
  await createGoogleAdsPlatform(cfg(g.t, { apiVersion: 'v27' }))!.pause({ campaign: 'camp-a', externalId: '4242' }, opts());
  assert.ok(g.calls.some((c) => c.url.startsWith('https://googleads.googleapis.com/v27/')));
  for (const bad of ['v26.2', 'v26.1', 'V26', '26', 'v2', 'latest']) assert.equal(createGoogleAdsPlatform(cfg(g.t, { apiVersion: bad })), null, bad);
});
test('GA10 정적: 어댑터는 process.env·기본 fetch·SDK·console·재시도 없음, 고정 주소 2곳뿐, 서버 연결은 platformSelect 한 곳', () => {
  const src = readFileSync('src/server/advertising/googleAdsPlatform.ts', 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /^import 'server-only';/);
  assert.ok(!/process\.env|fetch\(|console\.|localStorage|setInterval|require\(|import\(|from 'google-ads|retry|while \(/i.test(code));
  assert.deepEqual((code.match(/https:\/\/[^'`$\s]+/g) ?? []).sort(), ['https://googleads.googleapis.com', 'https://oauth2.googleapis.com/token']);
  // 11/23 B 승인: 서버 연결은 platformSelect 한 곳뿐(adRun → selectAdPlatform). 라우트·platform.ts는 어댑터를 직접 모른다
  for (const f of ['src/server/advertising/platform.ts', 'src/server/admin/adRun.ts', 'src/app/api/admin/ads/run/route.ts']) assert.ok(!/googleAdsPlatform/.test(readFileSync(f, 'utf8')), `${f}: 어댑터 직접 참조 금지`);
  assert.match(readFileSync('src/server/admin/adRun.ts', 'utf8'), /from '\.\.\/advertising\/platformSelect'/);
  assert.match(readFileSync('src/server/advertising/platformSelect.ts', 'utf8'), /from '\.\/googleAdsPlatform'/);
});

test('GA10 종료일(end_date_time, PM 11/22 P0): 캠페인 생성 본문에 종료일 23:59:59, read-back 종료일·계정 시간대가 정확히 같을 때만 endVerified', async () => {
  const g = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: OK_CAMP, search: searchBudget('2500000000') });
  const r = await createGoogleAdsPlatform(cfg(g.t))!.launch(req());
  assert.equal(r.endVerified, true);
  const camp = JSON.parse(g.calls.find((c) => c.url.endsWith('campaigns:mutate'))!.body);
  assert.equal(camp.operations[0].create.endDateTime, '2026-11-23 23:59:59');
  const q = JSON.parse(g.calls.find((c) => c.url.endsWith('googleAds:search'))!.body).query;
  assert.match(q, /campaign\.end_date_time/); assert.match(q, /customer\.time_zone/);
  for (const search of [searchBudget('2500000000', '2026-11-24 23:59:59'), searchBudget('2500000000', '2026-11-23 00:00:00'), searchBudget('2500000000', '2026-11-23 23:59:59', 'America/Los_Angeles'),
    { status: 200, text: JSON.stringify({ results: [{ campaignBudget: { amountMicros: '2500000000' } }] }) }, { status: 500 }] as Resp[]) {
    const h = fake({ token: OK_TOKEN, budget: OK_BUDGET, campaign: OK_CAMP, search });
    assert.equal((await createGoogleAdsPlatform(cfg(h.t))!.launch(req())).endVerified, false);
  }
  for (const bad of [{ endDate: undefined }, { endDate: '2026-11-2' }, { endDate: '2026-11-23 23:59:59' }]) {
    const f = fake({ token: OK_TOKEN });
    const e = (await run(createGoogleAdsPlatform(cfg(f.t))!, (p) => p.launch(req(bad)))).err!;
    assert.deepEqual([e.outcome, e.code, f.calls.length], ['failed', 'END_DATE_INVALID', 0]);
  }
});

test('GA11 계정 시간대 조회: customer.time_zone 1행만 인정, 형식 이상·빈 결과·HTTP 오류는 failed', async () => {
  const ok = fake({ token: OK_TOKEN, search: { status: 200, text: JSON.stringify({ results: [{ customer: { timeZone: 'Asia/Seoul' } }] }) } });
  assert.equal(await createGoogleAdsPlatform(cfg(ok.t))!.accountTimeZone(opts()), 'Asia/Seoul');
  assert.match(JSON.parse(ok.calls.find((c) => c.url.endsWith('googleAds:search'))!.body).query, /^SELECT customer\.time_zone FROM customer$/);
  for (const search of [{ status: 200, text: '{"results":[]}' }, { status: 200, text: '{"results":[{"customer":{"timeZone":"<x>"}}]}' }, { status: 200, text: '{"results":[{"customer":{}},{"customer":{}}]}' }, { status: 500 }] as Resp[]) {
    const f = fake({ token: OK_TOKEN, search });
    const e = (await run(createGoogleAdsPlatform(cfg(f.t))!, (p) => p.accountTimeZone(opts()))).err!;
    assert.ok(e && (e.outcome === 'failed' || e.outcome === 'unknown'));
  }
});
