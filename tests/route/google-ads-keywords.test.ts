// Google Ads 키워드(검색어) 생성 시험(PM 11/24 1번 승인) — 가짜 transport만. 실계정·실접속·실집행·광고비 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createGoogleAdsPlatform } from '../../src/server/advertising/googleAdsPlatform';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';
import type { PlatformError } from '../../src/server/advertising/platform';
import {
  candidateKeywords, approvedKeywordTexts, approvedRsaCreative, buildKeywordSet, checkKeyword, isApprovedKeywordSet, keywordSetOrReason, KEYWORDS_MAX,
} from '../../src/server/advertising/googleAdsCreative';

const CID = '1234567890';
const LANDING = 'https://example.com/internet-tv';
const enc = (s: string) => new TextEncoder().encode(s);
const stream = (t: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(t)); c.close(); } });
type Resp = { status: number; text: string; throws?: boolean };
const R = (status: number, body: unknown): Resp => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body) });
const KWS = candidateKeywords()!;
const kwOk = (): Resp => R(200, { results: KWS.map((_, i) => ({ resourceName: `customers/${CID}/adGroupCriteria/5~${50 + i}` })) });
const kwRow = (text: string, status = 'PAUSED', matchType = 'EXACT') => ({ adGroupCriterion: { status, keyword: { text, matchType } } });
const kwRowsOk = (): Resp => R(200, { results: KWS.map((k) => kwRow(k.text)) });
type Key = 'token' | 'budget' | 'campaign' | 'adGroup' | 'kw' | 'ad' | 'search' | 'status' | 'kwstatus';

function fake(over: Partial<Record<Key, Resp>> = {}) {
  const calls: { key: Key; body: string }[] = [];
  const t: BodyTransport = async (url, init) => {
    const body = init.body ? new TextDecoder().decode(init.body) : '';
    const key: Key = url.endsWith('/token') ? 'token' : url.endsWith('campaignBudgets:mutate') ? 'budget' : url.endsWith('campaigns:mutate') ? 'campaign'
      : url.endsWith('adGroups:mutate') ? 'adGroup' : url.endsWith('adGroupCriteria:mutate') ? 'kw' : url.endsWith('adGroupAds:mutate') ? 'ad'
      : body.includes('FROM ad_group_criterion') ? 'kwstatus' : body.includes('FROM ad_group_ad') ? 'status' : 'search';
    calls.push({ key, body });
    const d: Record<Key, Resp> = {
      token: R(200, { access_token: 'ya29.fake_access_token_0000' }),
      budget: R(200, { results: [{ resourceName: `customers/${CID}/campaignBudgets/7` }] }),
      campaign: R(200, { results: [{ resourceName: `customers/${CID}/campaigns/42` }] }),
      adGroup: R(200, { results: [{ resourceName: `customers/${CID}/adGroups/5` }] }),
      kw: kwOk(),
      ad: R(200, { results: [{ resourceName: `customers/${CID}/adGroupAds/5~9` }] }),
      search: R(200, { results: [{ campaignBudget: { amountMicros: '2500000000' }, campaign: { endDateTime: '2026-11-30 23:59:59' }, customer: { timeZone: 'Asia/Seoul' } }] }),
      status: R(200, { results: [{ campaign: { status: 'PAUSED' }, adGroup: { status: 'PAUSED' }, adGroupAd: { status: 'PAUSED' } }] }),
      kwstatus: kwRowsOk(),
    };
    const r = over[key] ?? d[key];
    if (r.throws) throw new Error('ECONNRESET secret-detail');
    return { status: r.status, body: stream(r.text) };
  };
  return { calls, t };
}
const mk = (t: BodyTransport, o: Record<string, unknown> = {}) =>
  createGoogleAdsPlatform({ transport: t, clientId: 'cid-SECRET', clientSecret: 'cs-SECRET', refreshToken: 'rt-SECRET', customerId: CID, creative: approvedRsaCreative(), keywords: KWS, landingUrl: LANDING, ...o } as Parameters<typeof createGoogleAdsPlatform>[0]);
const req = () => ({ campaign: 'camp-a', amountKrw: 5000, requestKey: 'req-keyword-test-0001', platformDailyBudgetKrw: 2500, endDate: '2026-11-30', deadlineAt: Date.now() + 5000 });
const err = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e) { return e as PlatformError; } };
const seq = (c: { key: Key }[]) => c.map((x) => x.key);

test('KW1 EXACT 키워드 정상 생성: 광고 그룹 다음 1요청, 승인된 문구 전부·EXACT·PAUSED·입찰가 없음, 다시 읽어 확인(endVerified=true)', async () => {
  const f = fake();
  const r = await mk(f.t)!.launch(req());
  assert.deepEqual([r.externalId, r.endVerified], ['42', true]);
  assert.deepEqual(seq(f.calls), ['token', 'budget', 'campaign', 'adGroup', 'kw', 'ad', 'search', 'status', 'kwstatus']);
  const ops = JSON.parse(f.calls.find((c) => c.key === 'kw')!.body).operations as { create: Record<string, unknown> }[];
  assert.equal(ops.length, KWS.length);
  assert.deepEqual(ops.map((o) => (o.create.keyword as { text: string }).text), approvedKeywordTexts());
  for (const { create } of ops) {
    assert.deepEqual(Object.keys(create).sort(), ['adGroup', 'keyword', 'status']);
    assert.deepEqual([create.status, create.adGroup, (create.keyword as { matchType: string }).matchType], ['PAUSED', `customers/${CID}/adGroups/5`, 'EXACT']);
    assert.ok(!/cpc|bid/i.test(JSON.stringify(create)), '입찰가(CPC)를 정하지 않는다');
  }
  assert.ok(KWS.length >= 1 && KWS.every((k) => k.matchType === 'EXACT'));
});

test('KW2 중복 생성 차단: 같은 문구·대소문자·띄어쓰기 변형은 거부, 승인 목록 자체에 중복 없음, 키워드 요청 실패 뒤 재시도 0(요청 1회)', async () => {
  const A = ['인터넷 재약정', '인터넷재약정', 'TV 인터넷 설치', 'tv 인터넷 설치'];
  assert.equal(keywordSetOrReason(['인터넷 재약정', '인터넷 재약정'], A).reason, 'DUPLICATE');
  assert.equal(keywordSetOrReason(['인터넷 재약정', '인터넷재약정'], A).reason, 'DUPLICATE', '띄어쓰기만 다른 문구');
  assert.equal(keywordSetOrReason(['TV 인터넷 설치', 'tv 인터넷 설치'], A).reason, 'DUPLICATE', '대소문자만 다른 문구');
  assert.equal(buildKeywordSet(['인터넷 재약정', 'TV 인터넷 설치'], A)?.length, 2, '서로 다른 문구는 통과');
  assert.equal(new Set(approvedKeywordTexts().map((t) => t.toLowerCase().replace(/\s+/g, ''))).size, approvedKeywordTexts().length, '승인 목록에 중복 없음');
  // 어댑터에 중복 집합을 넣어도 닫힘, 전송 0회
  const f = fake();
  assert.equal(mk(f.t, { keywords: [KWS[0], KWS[0]] }), null);
  assert.equal(f.calls.length, 0);
  // 키워드 요청이 5xx여도 같은 요청을 다시 보내지 않는다(자동 재시도 0)
  const g = fake({ kw: R(500, '{}') });
  assert.equal((await err(() => mk(g.t)!.launch(req())))?.code, 'KEYWORD_HTTP_ERROR');
  assert.equal(g.calls.filter((c) => c.key === 'kw').length, 1);
});

test('KW3 빈 키워드 차단: 빈 목록·없음·잘못된 형식·개수 초과는 어댑터 없음(닫힘), 전송 0회', () => {
  assert.equal(keywordSetOrReason([]).reason, 'EMPTY');
  assert.equal(buildKeywordSet([]), null);
  assert.equal(keywordSetOrReason('인터넷 재약정').reason, 'SHAPE');
  assert.equal(keywordSetOrReason(Array.from({ length: KEYWORDS_MAX + 1 }, (_, i) => `인터넷 ${i}`)).reason, 'TOO_MANY');
  for (const keywords of [[], null, undefined, 'x', {}, [{}]]) {
    const f = fake();
    assert.equal(mk(f.t, { keywords }), null, JSON.stringify(keywords));
    assert.equal(f.calls.length, 0);
  }
  assert.equal(isApprovedKeywordSet([]), false);
});

test('KW4 비활성 상품 키워드 차단: 휴대폰·유심·CCTV·집전화·알뜰폰 등은 승인 목록에 넣어도 거부, 인터넷·TV 말이 없어도 거부, 금지 주장 거부', () => {
  for (const bad of ['휴대폰 인터넷 결합', '유심 인터넷', 'USIM 인터넷', 'CCTV 인터넷 설치', '인터넷 집전화', '알뜰폰 인터넷', '인터넷 스마트폰', '모바일 인터넷 TV', 'LTE 인터넷', '보안 인터넷', '5G 인터넷']) {
    assert.equal(checkKeyword(bad, [bad]), 'PRODUCT_NOT_ACTIVE', bad);
    assert.equal(buildKeywordSet([bad], [bad]), null, bad);
  }
  assert.equal(checkKeyword('이사 설치', ['이사 설치']), 'OUT_OF_SCOPE');
  assert.equal(checkKeyword('인터넷 최저가', ['인터넷 최저가']), 'FORBIDDEN');
  assert.equal(checkKeyword('인터넷 무료 설치', ['인터넷 무료 설치']), 'FORBIDDEN');
  // 어댑터에 직접 넣어도 닫힘(전송 0회)
  const f = fake();
  assert.equal(mk(f.t, { keywords: [...KWS, { text: '휴대폰 인터넷 결합', matchType: 'EXACT' }] }), null);
  assert.equal(mk(f.t, { keywords: [{ text: '유심 인터넷', matchType: 'EXACT' }] }), null);
  assert.equal(f.calls.length, 0);
  // 현재 승인 목록은 전부 통과(인터넷·TV 범위)
  assert.ok(approvedKeywordTexts().every((t) => checkKeyword(t, approvedKeywordTexts()) === null));
});

test('KW5 승인되지 않은 키워드 차단: 목록 밖 문구·한 개라도 섞이면 전체 거부(null), BROAD·추가 키는 어댑터가 거부, 전송 0회', () => {
  assert.equal(checkKeyword('인터넷 설치 문의', approvedKeywordTexts()), 'NOT_APPROVED', '범위 안이어도 승인 목록 밖이면 거부');
  assert.equal(keywordSetOrReason([...approvedKeywordTexts(), '인터넷 설치 문의']).reason, 'NOT_APPROVED');
  assert.equal(buildKeywordSet([...approvedKeywordTexts(), '인터넷 설치 문의']), null, '일부만 걸러 내지 않고 전체를 만들지 않는다');
  assert.equal(checkKeyword(123, approvedKeywordTexts()), 'SHAPE');
  assert.equal(checkKeyword(' 인터넷 재약정', approvedKeywordTexts()), 'FORMAT');
  assert.equal(checkKeyword('<script>인터넷', approvedKeywordTexts()), 'FORMAT');
  const f = fake();
  for (const keywords of [
    [{ text: '인터넷 설치 문의', matchType: 'EXACT' }],
    [{ text: KWS[0]!.text, matchType: 'BROAD' }],
    [{ text: KWS[0]!.text, matchType: 'PHRASE' }],
    [{ text: KWS[0]!.text, matchType: 'EXACT', cpcBidMicros: '1000000' }],
    [{ text: KWS[0]!.text }],
  ]) assert.equal(mk(f.t, { keywords }), null, JSON.stringify(keywords));
  assert.equal(f.calls.length, 0);
});

test('KW6 API 오류 fail-closed: 키워드 단계 거부·5xx·끊김·형식 이상은 모두 unknown(고정 코드), 광고·확인 요청 없음, 비밀 비노출', async () => {
  const wrongCount = R(200, { results: KWS.slice(1).map((_, i) => ({ resourceName: `customers/${CID}/adGroupCriteria/5~${50 + i}` })) });
  for (const [resp, code] of [
    [R(400, '{}'), 'KEYWORD_BAD_REQUEST'], [R(401, '{}'), 'KEYWORD_AUTH_ERROR'], [R(403, '{}'), 'KEYWORD_AUTH_ERROR'], [R(429, '{}'), 'KEYWORD_RATE_LIMITED'], [R(500, '{}'), 'KEYWORD_HTTP_ERROR'],
    [{ status: 0, text: '', throws: true } as Resp, 'KEYWORD_TRANSPORT_ERROR'],
    [R(200, 'not json'), 'KEYWORD_BAD_RESPONSE'], [R(200, '{"results":[]}'), 'KEYWORD_BAD_RESPONSE'], [wrongCount, 'KEYWORD_BAD_RESPONSE'],
    [R(200, { results: KWS.map((_, i) => ({ resourceName: `customers/999/adGroupCriteria/5~${i}` })) }), 'KEYWORD_BAD_RESPONSE'],
    [R(200, { results: KWS.map(() => ({})) }), 'KEYWORD_BAD_RESPONSE'],
  ] as const) {
    const f = fake({ kw: resp });
    const e = await err(() => mk(f.t)!.launch(req()));
    assert.deepEqual([e?.outcome, e?.code], ['unknown', code], `${resp.status} ${code}`);
    assert.ok(!seq(f.calls).includes('ad') && !seq(f.calls).includes('status') && !seq(f.calls).includes('kwstatus'), '키워드 실패 뒤 광고·확인 요청 없음');
    assert.ok(!/SECRET|ya29|secret-detail/.test(JSON.stringify(e)), '오류에 비밀·원문 없음');
  }
  // 다시 읽기 불일치·실패는 확인 실패(endVerified=false) → 서버가 즉시 중지. 캠페인 ID는 그대로 돌려준다
  const extra = [...KWS.map((k) => kwRow(k.text)), kwRow('인터넷 설치 문의')];
  const dup = [...KWS.slice(1).map((k) => kwRow(k.text)), kwRow(KWS[1]!.text)];
  for (const [name, kwstatus] of [
    ['누락', R(200, { results: KWS.slice(1).map((k) => kwRow(k.text)) })], ['추가', R(200, { results: extra })], ['중복 문구', R(200, { results: dup })],
    ['ENABLED', R(200, { results: KWS.map((k, i) => kwRow(k.text, i === 0 ? 'ENABLED' : 'PAUSED')) })],
    ['BROAD', R(200, { results: KWS.map((k, i) => kwRow(k.text, 'PAUSED', i === 0 ? 'BROAD' : 'EXACT')) })],
    ['목록 밖 문구', R(200, { results: KWS.map((k, i) => kwRow(i === 0 ? '인터넷 설치 문의' : k.text)) })],
    ['빈 결과', R(200, { results: [] })], ['조회 500', R(500, '{}')], ['형식 이상', R(200, 'x')],
  ] as const) {
    const r = await mk(fake({ kwstatus }).t)!.launch(req());
    assert.deepEqual([r.externalId, r.endVerified], ['42', false], name);
  }
});

test('KW7 PAUSED 보장 유지: 캠페인·광고 그룹·키워드·광고 모두 PAUSED, ENABLED·BROAD·입찰가 요청 없음, 활성화 호출 없음', async () => {
  const f = fake();
  await mk(f.t)!.launch(req());
  const bodies = f.calls.filter((c) => ['campaign', 'adGroup', 'kw', 'ad'].includes(c.key)).map((c) => ({ key: c.key, ops: JSON.parse(c.body).operations as { create: { status?: string } }[] }));
  assert.deepEqual(bodies.map((b) => b.key), ['campaign', 'adGroup', 'kw', 'ad']);
  for (const b of bodies) for (const o of b.ops) assert.equal(o.create.status, 'PAUSED', b.key);
  assert.ok(!/ENABLED|BROAD|PHRASE|cpcBid/i.test(f.calls.filter((c) => c.key !== 'status' && c.key !== 'kwstatus').map((c) => c.body).join('\n')));
  // 정적: 소스에 EXACT 외 매치 유형 생성이 없고, 키워드 코드에 활성화(ENABLED) 상태 설정이 없다
  const dir = new URL('../../src/server/advertising/', import.meta.url);
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/matchType\W+['"](\w+)['"]/g)) assert.equal(m[1], 'EXACT', `${file}: matchType`);
  }
  const creative = readFileSync(new URL('googleAdsCreative.ts', dir), 'utf8');
  assert.ok(!/status:\s*'ENABLED'/.test(creative), '소재·키워드 본문 생성 코드에 ENABLED 없음');
});

test('KW8 최종 승인 보류(PM 11/24): 승인 근거가 없으면 실제 광고 경로 키워드 0개 → 어댑터 없음, 형식 맞는 PM 결정 번호가 있을 때만 후보 집합', async () => {
  const { approvedKeywords, KEYWORD_APPROVAL_REF } = await import('../../src/server/advertising/googleAdsCreative');
  assert.equal(KEYWORD_APPROVAL_REF, null, '현재 보류');
  assert.equal(approvedKeywords(), null);
  for (const bad of [null, '', 'approved', 'PM-2026-11-24', 'pm-2026-11-24-keywords', 'PM-2026-11-24-Keywords!']) assert.equal(approvedKeywords(bad), null, String(bad));
  assert.deepEqual(approvedKeywords('PM-2026-12-01-keywords-final'), candidateKeywords(), '승인되면 후보 집합 그대로(새 키워드 추가 없음)');
  const { selectAdPlatform } = await import('../../src/server/advertising/platformSelect');
  assert.equal(selectAdPlatform({ AD_PLATFORM: 'google_ads', GOOGLE_ADS_CLIENT_ID: 'a', GOOGLE_ADS_CLIENT_SECRET: 'b', GOOGLE_ADS_REFRESH_TOKEN: 'c', GOOGLE_ADS_CUSTOMER_ID: '1234567890', AD_LANDING_URL: 'https://example.com/internet-tv' }), null);
});
