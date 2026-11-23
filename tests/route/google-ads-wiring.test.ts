// Google Ads 서버 연결·반응형 검색광고 소재 시험(PM 11/23 B·C 승인) — 가짜 transport·가짜 fetch만. 실계정·실접속·실집행이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedRsaCreative, buildRsaCreative, finalUrlSuffixFor, googleTextWidth, landingUrlFrom, RSA_DESCRIPTION_MAX_WIDTH, RSA_HEADLINE_MAX_WIDTH } from '../../src/server/advertising/googleAdsCreative';
import { validateAdCopy } from '../../src/server/advertising/adGeneration';
import { selectAdPlatform } from '../../src/server/advertising/platformSelect';
import { googleAdsFetchTransport } from '../../src/server/advertising/googleAdsTransport';
import { createGoogleAdsPlatform } from '../../src/server/advertising/googleAdsPlatform';
import { mockPlatform, type PlatformError } from '../../src/server/advertising/platform';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';
import { parseAttribution } from '../../src/content/attribution';

const CID = '1234567890';
const LANDING = 'https://example.com/internet-tv';
const GOOGLE_ENV = { AD_PLATFORM: 'google_ads', GOOGLE_ADS_CLIENT_ID: 'id', GOOGLE_ADS_CLIENT_SECRET: 'sec', GOOGLE_ADS_REFRESH_TOKEN: 'ref', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890', AD_LANDING_URL: LANDING };

test('GW1 검수 소재: 제목 3~15개(너비 ≤30)·설명 2~4개(너비 ≤90), 전부 기존 검증기 통과, 중복 없음, 숫자 없음', () => {
  const c = approvedRsaCreative()!;
  assert.ok(c.headlines.length >= 3 && c.headlines.length <= 15 && c.descriptions.length >= 2 && c.descriptions.length <= 4);
  for (const h of c.headlines) assert.ok(googleTextWidth(h) <= RSA_HEADLINE_MAX_WIDTH, h);
  for (const d of c.descriptions) assert.ok(googleTextWidth(d) <= RSA_DESCRIPTION_MAX_WIDTH, d);
  assert.equal(new Set(c.headlines).size, c.headlines.length);
  assert.equal(new Set(c.descriptions).size, c.descriptions.length);
  for (const [i, h] of c.headlines.entries()) assert.ok(validateAdCopy({ title: h, description: c.descriptions[i % c.descriptions.length] }).ok);
  assert.ok(![...c.headlines, ...c.descriptions].some((s) => /\d/.test(s)));
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.headlines));
});

test('GW2 Google 글자 수: 한글·한자·전각은 2, 영문·숫자·공백은 1', () => {
  assert.deepEqual([googleTextWidth('가'), googleTextWidth('a'), googleTextWidth('가 a'), googleTextWidth('漢'), googleTextWidth('ＡＢ')], [2, 1, 4, 2, 4]);
});

test('GW3 소재 조립: 금지 주장·금액·형식 오류 문안은 버리고, 개수가 모자라면 null(만들지 않음)', () => {
  const ok = [
    { title: '이사 전 인터넷 신청', description: '이사 날짜에 맞춰 설치 일정과 이전 조건을 먼저 확인하세요' },
    { title: '약정 끝나기 전 확인', description: '만료가 가까우면 재약정과 변경 조건을 함께 비교해 보세요' },
    { title: '통신사 변경 전 확인', description: '위약금·설치 조건·결합 적용 여부를 신청 전에 확인하세요' },
  ];
  assert.ok(buildRsaCreative(ok));
  const bad = [{ title: '최대 현금 지원', description: '지금 신청하면 사은품을 바로 드립니다 놓치지 마세요' }, { title: '10만원 지원', description: x(30) }, { title: 'x', description: 'y' }, null, 'str', { title: ok[0]!.title, description: ok[0]!.description, extra: 1 }];
  assert.equal(buildRsaCreative([ok[0], ok[1], ...bad]), null);
  assert.equal(buildRsaCreative([...ok, ...ok]).headlines.length, 3); // 중복 제거
});
function x(n: number) { return '가'.repeat(n); }

test('GW4 최종 URL: https·호스트만 허용, http·쿼리·조각·계정정보·포트·IP·localhost·빈 값은 null', () => {
  assert.equal(landingUrlFrom(LANDING), LANDING);
  for (const u of [undefined, null, '', ' ', 'http://example.com/', 'https://example.com/?a=1', 'https://example.com/#x', 'https://u:p@example.com/', 'https://example.com:8443/', 'https://127.0.0.1/', 'https://localhost/', 'javascript:alert(1)', 'https://exa mple.com/'])
    assert.equal(landingUrlFrom(u as string), null, String(u));
});

test('GW5 클릭 추적 꼬리표: 상담·접수와 같은 캠페인 키 형식만(점·대문자·빈 값 거부)', () => {
  assert.equal(finalUrlSuffixFor('camp-a_1'), 'utm_source=google&utm_medium=cpc&utm_campaign=camp-a_1');
  for (const c of ['a.b', 'Camp', '', '-a', 'a'.repeat(65)]) assert.equal(finalUrlSuffixFor(c), null, c);
});

test('GW6 플랫폼 선택: mock은 모의, google_ads는 인증 4종·최종 URL이 모두 있을 때만, 하나라도 없으면 null. 만들 때 외부 호출 0', () => {
  const real = globalThis.fetch; let n = 0;
  globalThis.fetch = (async () => { n++; throw new Error('no'); }) as typeof fetch;
  try {
    assert.equal(selectAdPlatform({ AD_PLATFORM: 'mock' }), mockPlatform);
    for (const v of [undefined, '', 'google', 'GOOGLE_ADS', 'naver']) assert.equal(selectAdPlatform({ ...GOOGLE_ENV, AD_PLATFORM: v }), null, String(v));
    for (const k of ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'AD_LANDING_URL'])
      assert.equal(selectAdPlatform({ ...GOOGLE_ENV, [k]: '' }), null, k);
    assert.equal(selectAdPlatform({ ...GOOGLE_ENV, AD_LANDING_URL: 'http://example.com/' }), null);
    const p = selectAdPlatform(GOOGLE_ENV)!;
    assert.deepEqual([p.name, p.live], ['google_ads', true]);
    assert.equal(n, 0);
  } finally { globalThis.fetch = real; }
});

test('GW7 실제 전송: 허용 주소 2곳(토큰·googleads mutate/search)만 보내고, 그 밖은 fetch 0회로 거부. 리다이렉트 금지·캐시 금지', async () => {
  const real = globalThis.fetch; const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{}', { status: 200 }); }) as typeof fetch;
  const init = { method: 'POST' as const, headers: {}, signal: new AbortController().signal, redirect: 'error' as const };
  try {
    for (const u of ['https://evil.example/token', 'http://oauth2.googleapis.com/token', 'https://googleads.googleapis.com/v26/customers/1/campaigns', 'https://googleads.googleapis.com.evil/v26/customers/1/campaigns:mutate', 'https://oauth2.googleapis.com/token?x=1'])
      await assert.rejects(googleAdsFetchTransport(u, init), /DESTINATION_NOT_ALLOWED/, u);
    assert.equal(seen.length, 0);
    await googleAdsFetchTransport('https://oauth2.googleapis.com/token', init);
    await googleAdsFetchTransport(`https://googleads.googleapis.com/v26/customers/${CID}/adGroupAds:mutate`, init);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => s.init.redirect === 'error' && s.init.cache === 'no-store'));
  } finally { globalThis.fetch = real; }
});

// 캠페인이 생긴 뒤의 실패는 전부 unknown(사람 확인·자동 재시도 없음), 실패 뒤 다음 단계 요청 0
const enc = (s: string) => new TextEncoder().encode(s);
const stream = (t: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(t)); c.close(); } });
const R = (status: number, body: unknown) => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body) });
function fake(over: Record<string, { status: number; text: string }>) {
  const calls: string[] = [];
  const t: BodyTransport = async (url, init) => {
    const body = init.body ? new TextDecoder().decode(init.body) : '';
    const k = url.endsWith('/token') ? 'token' : url.endsWith('campaignBudgets:mutate') ? 'budget' : url.endsWith('campaigns:mutate') ? 'campaign'
      : url.endsWith('adGroups:mutate') ? 'adGroup' : url.endsWith('adGroupAds:mutate') ? 'ad' : body.includes('FROM ad_group_ad') ? 'status' : 'search';
    calls.push(k);
    const d: Record<string, { status: number; text: string }> = {
      token: R(200, { access_token: 'ya29.fake_access_token_0000' }), budget: R(200, { results: [{ resourceName: `customers/${CID}/campaignBudgets/7` }] }),
      campaign: R(200, { results: [{ resourceName: `customers/${CID}/campaigns/42` }] }), adGroup: R(200, { results: [{ resourceName: `customers/${CID}/adGroups/5` }] }),
      ad: R(200, { results: [{ resourceName: `customers/${CID}/adGroupAds/5~9` }] }),
      search: R(200, { results: [{ campaignBudget: { amountMicros: '2500000000' }, campaign: { endDateTime: '2026-11-30 23:59:59' }, customer: { timeZone: 'Asia/Seoul' } }] }),
      status: R(200, { results: [{ campaign: { status: 'PAUSED' }, adGroup: { status: 'PAUSED' }, adGroupAd: { status: 'PAUSED' } }] }),
    };
    const r = over[k] ?? d[k]!;
    return { status: r.status, body: stream(r.text) };
  };
  return { calls, p: createGoogleAdsPlatform({ transport: t, clientId: 'a', clientSecret: 'b', refreshToken: 'c', customerId: CID, creative: approvedRsaCreative(), landingUrl: LANDING })! };
}
const req = () => ({ campaign: 'camp-a', amountKrw: 5000, requestKey: 'req-0123456789abcdef', platformDailyBudgetKrw: 2500, endDate: '2026-11-30', deadlineAt: Date.now() + 5000 });
const err = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e) { return e as PlatformError; } };

test('GW8 광고 그룹·광고 단계 실패: 거부(400·401)·5xx·형식 이상 모두 unknown, 고정 코드만, 다음 단계 요청 없음', async () => {
  for (const [k, resp, code] of [
    ['adGroup', R(400, '{}'), 'AD_GROUP_BAD_REQUEST'], ['adGroup', R(401, '{}'), 'AD_GROUP_AUTH_ERROR'], ['adGroup', R(500, '{}'), 'AD_GROUP_HTTP_ERROR'],
    ['adGroup', R(200, { results: [{ resourceName: 'customers/999/adGroups/5' }] }), 'AD_GROUP_BAD_RESPONSE'],
    ['ad', R(400, '{}'), 'AD_BAD_REQUEST'], ['ad', R(503, '{}'), 'AD_HTTP_ERROR'], ['ad', R(200, '{"results":[]}'), 'AD_BAD_RESPONSE'],
  ] as const) {
    const f = fake({ [k]: resp });
    const e = await err(() => f.p.launch(req()));
    assert.deepEqual([e?.outcome, e?.code], ['unknown', code], `${k} ${resp.status}`);
    if (k === 'adGroup') assert.ok(!f.calls.includes('ad'), '광고 그룹 실패 뒤 광고 요청 없음');
    assert.ok(!f.calls.includes('search') && !f.calls.includes('status'));
  }
});

test('GW9 다시 읽기: 캠페인·광고 그룹·광고가 정확히 1세트·모두 PAUSED일 때만 endVerified=true, 아니면 false(서버가 즉시 중지)', async () => {
  assert.equal((await fake({}).p.launch(req())).endVerified, true);
  const row = (c: string, g: string, a: string) => ({ campaign: { status: c }, adGroup: { status: g }, adGroupAd: { status: a } });
  for (const results of [[row('PAUSED', 'PAUSED', 'ENABLED')], [row('ENABLED', 'PAUSED', 'PAUSED')], [row('PAUSED', 'ENABLED', 'PAUSED')], [], [row('PAUSED', 'PAUSED', 'PAUSED'), row('PAUSED', 'PAUSED', 'PAUSED')]]) {
    const r = await fake({ status: R(200, { results }) }).p.launch(req());
    assert.deepEqual([r.externalId, r.endVerified], ['42', false], JSON.stringify(results));
  }
  const r5 = await fake({ status: R(500, '{}') }).p.launch(req());
  assert.deepEqual([r5.dailyBudgetKrw, r5.endVerified], [0, false]);
});

test('GW10 클릭→UTM→상담 종단(모의): 광고 최종 URL 꼬리표를 고객 화면 attribution이 그대로 읽어 같은 캠페인 키로 상담·접수에 붙인다', async () => {
  const f = fake({});
  await f.p.launch(req());
  const suffix = finalUrlSuffixFor('camp-a')!;
  // 구글은 클릭 시 최종 URL 뒤에 꼬리표를 붙인다 → 접수 화면이 읽는 값
  assert.deepEqual(parseAttribution(`?${suffix}`), { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'camp-a' });
});
