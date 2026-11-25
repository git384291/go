// 테스트 계정 read-back 검증 스크립트 시험(가짜 transport만, 실계정 호출 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidateKeywords } from '../../src/server/advertising/googleAdsCreative';
import { kstTomorrow, runReadback, type ReadbackLine } from '../../scripts/google-ads-probe/readback';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const NOW = new Date('2026-11-22T14:30:00Z'); // KST 23:30 → 내일 = 2026-11-23
const ENV = { AD_LANDING_URL: 'https://example.com/internet-tv', GOOGLE_ADS_CLIENT_ID: 'cid-SECRET', GOOGLE_ADS_CLIENT_SECRET: 'cs-SECRET', GOOGLE_ADS_REFRESH_TOKEN: 'rt-SECRET', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890', GOOGLE_ADS_PROBE_READBACK: 'test-account-only' };
const ACCT = { currencyCode: 'KRW', testAccount: true, manager: false, timeZone: 'Asia/Seoul' };
type Over = { acct?: Record<string, unknown>; readEnd?: string; readMicros?: string; readTz?: string; pauseOk?: boolean; campStatus?: number };
const body = (o: unknown) => new Response(JSON.stringify(o)).body;
function fake(o: Over = {}) {
  const calls: { url: string; body: string }[] = [];
  const t: BodyTransport = async (url, init) => {
    const b = init.body ? new TextDecoder().decode(init.body) : '';
    calls.push({ url, body: b });
    if (url.endsWith('/token')) return { status: 200, body: body({ access_token: 'ya29.access-SECRET-token' }) };
    // 11/23 C: 광고 그룹·반응형 검색광고(PAUSED)와 상태 확인 조회
    if (url.endsWith('adGroups:mutate')) return { status: 200, body: body({ results: [{ resourceName: 'customers/1234567890/adGroups/66' }] }) };
    if (url.endsWith('adGroupCriteria:mutate')) return { status: 200, body: body({ results: candidateKeywords()!.map((_, i) => ({ resourceName: `customers/1234567890/adGroupCriteria/66~${200 + i}` })) }) };
    if (url.endsWith('googleAds:search') && b.includes('FROM ad_group_criterion')) return { status: 200, body: body({ results: candidateKeywords()!.map((k) => ({ adGroupCriterion: { status: 'PAUSED', keyword: { text: k.text, matchType: 'EXACT' } } })) }) };
    if (url.endsWith('adGroupAds:mutate')) return { status: 200, body: body({ results: [{ resourceName: 'customers/1234567890/adGroupAds/66~77' }] }) };
    if (url.endsWith('googleAds:search') && b.includes('FROM ad_group_ad')) return { status: 200, body: body({ results: [{ campaign: { status: 'PAUSED' }, adGroup: { status: 'PAUSED' }, adGroupAd: { status: 'PAUSED' } }] }) };
    if (url.endsWith('googleAds:search') && b.includes('FROM customer')) return { status: 200, body: body({ results: [{ customer: o.acct ?? ACCT }] }) };
    if (url.endsWith('campaignBudgets:mutate')) return { status: 200, body: body({ results: [{ resourceName: 'customers/1234567890/campaignBudgets/55' }] }) };
    if (url.endsWith('campaigns:mutate') && b.includes('"create"')) return { status: o.campStatus ?? 200, body: body({ results: [{ resourceName: 'customers/1234567890/campaigns/987654' }] }) };
    if (url.endsWith('campaigns:mutate')) return { status: 200, body: body({ results: [{ resourceName: o.pauseOk === false ? 'x' : 'customers/1234567890/campaigns/987654' }] }) };
    if (url.endsWith('googleAds:search')) return { status: 200, body: body({ results: [{ campaignBudget: { amountMicros: o.readMicros ?? '1000000000' }, campaign: { endDateTime: o.readEnd ?? '2026-11-23 23:59:59' }, customer: { timeZone: o.readTz ?? 'Asia/Seoul' } }] }) };
    throw new Error('unexpected ' + url);
  };
  return { t, calls };
}
const go = async (env: Record<string, string>, f: ReturnType<typeof fake>) => { const lines: ReadbackLine[] = []; const code = await runReadback(env, f.t, (l) => lines.push(l), () => NOW); return { code, lines, out: JSON.stringify(lines) }; };
const mutates = (f: ReturnType<typeof fake>) => f.calls.filter((c) => /:mutate$/.test(c.url));

test('RB1 실행 플래그 없거나 설정 누락: 호출 0회(종료 2)', async () => {
  for (const env of [{ ...ENV, GOOGLE_ADS_PROBE_READBACK: '' }, { ...ENV, GOOGLE_ADS_PROBE_READBACK: 'yes' }, { GOOGLE_ADS_PROBE_READBACK: 'test-account-only' }]) {
    const f = fake(); assert.equal((await go(env as never, f)).code, 2); assert.equal(f.calls.length, 0);
  }
});
test('RB2 테스트 계정·KRW·Asia/Seoul·비관리자가 아니면 읽기만, 변경 0회(종료 4)', async () => {
  for (const [acct, reason] of [[{ ...ACCT, testAccount: false }, 'NOT_TEST_ACCOUNT'], [{ ...ACCT, manager: true }, 'MANAGER_ACCOUNT'], [{ ...ACCT, currencyCode: 'USD' }, 'NOT_KRW'], [{ ...ACCT, timeZone: 'America/New_York' }, 'NOT_ASIA_SEOUL']] as const) {
    const f = fake({ acct }); const r = await go(ENV, f);
    assert.equal(r.code, 4, reason); assert.equal(mutates(f).length, 0); assert.equal(r.lines.at(-1)!.reason, reason);
  }
});
test('RB3 정상: 예산 1,000원·PAUSED 캠페인·종료 KST 내일 23:59:59 → 예산·종료일·시간대 read-back → pause 응답 확인(종료 0), 출력에 비밀·ID 없음', async () => {
  const f = fake(); const r = await go(ENV, f);
  assert.equal(r.code, 0, r.out);
  assert.equal(kstTomorrow(NOW), '2026-11-23');
  const create = JSON.parse(f.calls.find((c) => c.url.endsWith('campaigns:mutate') && c.body.includes('"create"'))!.body);
  assert.equal(create.operations[0].create.status, 'PAUSED');
  assert.equal(create.operations[0].create.endDateTime, '2026-11-23 23:59:59');
  assert.equal(JSON.parse(f.calls.find((c) => c.url.endsWith('campaignBudgets:mutate'))!.body).operations[0].create.amountMicros, '1000000000');
  assert.ok(!mutates(f).some((c) => /asset|ENABLED|BROAD|PHRASE|cpcBid/i.test(c.body)));
  // 11/23 C: 예산·캠페인·광고 그룹·반응형 검색광고 생성(모두 PAUSED) + pause, 재시도 없음
  assert.deepEqual(mutates(f).map((c) => c.url.replace(/^.*\//, '')), ['campaignBudgets:mutate', 'campaigns:mutate', 'adGroups:mutate', 'adGroupCriteria:mutate', 'adGroupAds:mutate', 'campaigns:mutate']);
  const launch = r.lines.find((l) => l.step === 'launch')!;
  assert.deepEqual([launch.budgetReadBack, launch.endDateTimeReadBack], [true, true]);
  assert.equal(r.lines.at(-1)!.ok, true);
  for (const s of ['SECRET', '1234567890', '987654', 'ya29']) assert.ok(!r.out.includes(s), s);
});
test('RB4 read-back 불일치(종료일·예산·시간대)는 종료 6, 그래도 pause 응답은 확인', async () => {
  for (const o of [{ readEnd: '2026-11-24 23:59:59' }, { readMicros: '2000000000' }, { readTz: 'UTC' }]) {
    const f = fake(o); const r = await go(ENV, f);
    assert.equal(r.code, 6, JSON.stringify(o)); assert.equal(r.lines.at(-1)!.step, 'pause');
  }
});
test('RB5 pause 응답 이상은 종료 7, 캠페인 생성 실패는 종료 5(pause 시도 없음)', async () => {
  assert.equal((await go(ENV, fake({ pauseOk: false }))).code, 7);
  const f = fake({ campStatus: 400 }); assert.equal((await go(ENV, f)).code, 5);
  assert.equal(mutates(f).length, 2);
});
test('RB6 정적: CI·package.json은 실행하지 않음, ENABLED 생성 없음', () => {
  const src = readFileSync('scripts/google-ads-probe/readback.ts', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/ENABLED|retry|while \(/.test(src));
  assert.ok(!/initialStatus/.test(src));
  for (const p of ['package.json', '.github/workflows/ci.yml']) assert.ok(!/google-ads-probe\/readback/.test(readFileSync(p, 'utf8')), p);
});
