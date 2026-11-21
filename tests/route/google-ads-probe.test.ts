// 테스트 계정 전용 진단 스크립트 시험(가짜 transport만, 실계정 호출 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { googleErrorCodes, runProbe, type ProbeLine, type ProbeTransport } from '../../scripts/google-ads-probe/core';

const ENV = { GOOGLE_ADS_CLIENT_ID: 'cid-SECRET', GOOGLE_ADS_CLIENT_SECRET: 'cs-SECRET', GOOGLE_ADS_REFRESH_TOKEN: 'rt-SECRET', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890' };
const ACCESS = 'ya29.access-SECRET';
type R = { status: number; text: string };
const acct = (c: Record<string, unknown>): R => ({ status: 200, text: JSON.stringify({ results: [{ customer: c }] }) });
const gerr = (status: number, s: string, codes: Record<string, string>[]): R => ({ status, text: JSON.stringify({ error: { status: s, message: 'customer 1234567890 secret detail', details: [{ errors: codes.map((errorCode) => ({ errorCode, message: 'leak 1234567890' })) }] } }) });
const fake = (s: { token?: R; read?: R; mutate?: R }) => {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const t: ProbeTransport = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (url.endsWith('/token')) return s.token ?? { status: 200, text: JSON.stringify({ access_token: ACCESS }) };
    if (url.endsWith('googleAds:search')) return s.read ?? acct({ currencyCode: 'KRW', testAccount: true, manager: false });
    if (url.endsWith('googleAds:mutate')) return s.mutate ?? { status: 200, text: '{}' };
    throw new Error('unexpected url');
  };
  return { t, calls };
};
const go = async (env: Record<string, string | undefined>, f: ReturnType<typeof fake>) => { const lines: ProbeLine[] = []; const code = await runProbe(env, f.t, (l) => lines.push(l)); return { code, lines, out: JSON.stringify(lines) }; };
const mutates = (f: ReturnType<typeof fake>) => f.calls.filter((c) => /:mutate$/.test(c.url));

test('GP1 필수 환경변수 없으면 이름만 출력하고 호출 0회(종료 2), developer token은 필수 아님', async () => {
  const f = fake({});
  const r = await go({ GOOGLE_ADS_CLIENT_ID: 'x' }, f);
  assert.equal(r.code, 2); assert.equal(f.calls.length, 0);
  assert.deepEqual(r.lines[0]!.missing, ['GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID']);
  for (const bad of [{ GOOGLE_ADS_CUSTOMER_ID: '12' }, { GOOGLE_ADS_API_VERSION: 'v26.2' }, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: 'abc' }]) {
    const g = fake({}); assert.equal((await go({ ...ENV, ...bad }, g)).code, 2); assert.equal(g.calls.length, 0);
  }
});
test('GP2 테스트 계정 아님·관리자 계정: 읽기만 하고 변경 호출 0회(종료 4), 통화·KRW 여부 보고', async () => {
  for (const [c, reason] of [[{ currencyCode: 'KRW', testAccount: false, manager: false }, 'NOT_TEST_ACCOUNT'], [{ currencyCode: 'USD' }, 'NOT_TEST_ACCOUNT'], [{ currencyCode: 'KRW', testAccount: true, manager: true }, 'MANAGER_ACCOUNT']] as const) {
    const f = fake({ read: acct(c) });
    const r = await go(ENV, f);
    assert.equal(r.code, 4); assert.equal(mutates(f).length, 0);
    const a = r.lines.find((l) => l.step === 'account_read')!;
    assert.deepEqual([a.currency, a.krw], [c.currencyCode, c.currencyCode === 'KRW']);
    assert.equal(r.lines.at(-1)!.reason, reason);
  }
});
test('GP3 테스트 계정: validateOnly=true 묶음 1회만(예산 -1 임시 이름 + 캠페인 PAUSED·소재 없음), 종료 0', async () => {
  const f = fake({});
  const r = await go(ENV, f);
  assert.equal(r.code, 0);
  assert.deepEqual(f.calls.map((c) => c.url.replace(/^https:\/\/[^/]+/, '')), ['/token', '/v26/customers/1234567890/googleAds:search', '/v26/customers/1234567890/googleAds:mutate']);
  const b = JSON.parse(mutates(f)[0]!.body);
  assert.equal(b.validateOnly, true);
  assert.equal(b.mutateOperations[0].campaignBudgetOperation.create.resourceName, 'customers/1234567890/campaignBudgets/-1');
  assert.deepEqual([b.mutateOperations[1].campaignOperation.create.status, b.mutateOperations[1].campaignOperation.create.campaignBudget], ['PAUSED', 'customers/1234567890/campaignBudgets/-1']);
  assert.ok(!/adGroup|adGroupAd|asset|keyword/i.test(mutates(f)[0]!.body));
  assert.ok(!('developer-token' in mutates(f)[0]!.headers));
  assert.equal(r.lines.at(-1)!.executed, false);
});
test('GP4 Google 오류: 오류코드 enum 이름만 보고(메시지·고객 ID 없음), 인증 실패는 조회 0', async () => {
  assert.deepEqual(googleErrorCodes(gerr(403, 'PERMISSION_DENIED', [{ authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }]).text), ['PERMISSION_DENIED', 'authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION']);
  const f = fake({ mutate: gerr(400, 'INVALID_ARGUMENT', [{ fieldError: 'REQUIRED' }, { bad: 'lower case' }]) });
  const r = await go(ENV, f);
  assert.equal(r.code, 5);
  assert.deepEqual(r.lines.at(-1)!.googleErrorCodes, ['INVALID_ARGUMENT', 'fieldError.REQUIRED']);
  const o = fake({ token: { status: 400, text: JSON.stringify({ error: 'invalid_grant', error_description: 'Bad rt-SECRET' }) } });
  const ro = await go(ENV, o);
  assert.deepEqual([ro.code, o.calls.length, ro.lines.at(-1)!.googleErrorCodes], [3, 1, ['oauth.invalid_grant']]);
  const rr = fake({ read: gerr(403, 'PERMISSION_DENIED', [{ authorizationError: 'USER_PERMISSION_DENIED' }]) });
  assert.equal((await go(ENV, rr)).code, 3); assert.equal(mutates(rr).length, 0);
  for (const x of [r, ro]) for (const s of ['SECRET', '1234567890', 'leak', 'detail', ACCESS]) assert.ok(!x.out.includes(s), s);
});
test('GP5 정적: 변경 요청은 validateOnly 묶음 한 곳뿐, 캠페인·예산 단독 mutate·재시도 없음, CI는 실행하지 않음', () => {
  const core = readFileSync('scripts/google-ads-probe/core.ts', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((core.match(/:mutate/g) ?? []).length, 1);
  assert.ok(!/campaigns:mutate|campaignBudgets:mutate|validateOnly: false|ENABLED|retry|while \(/.test(core));
  assert.match(core, /validateOnly: true/);
  for (const f of ['package.json', '.github/workflows/ci.yml']) { try { assert.ok(!/google-ads-probe\/run/.test(readFileSync(f, 'utf8')), f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
});
test('GP6 인증정보·네트워크 없음: 전송 실패(status 0)면 조회·변경 0회로 안전 종료(3), 출력에 비밀 없음', async () => {
  const f = fake({ token: { status: 0, text: '' } });
  const r = await go(ENV, f);
  assert.deepEqual([r.code, f.calls.length, mutates(f).length], [3, 1, 0]);
  for (const s of ['SECRET', '1234567890']) assert.ok(!r.out.includes(s));
  const n = fake({});
  assert.deepEqual([(await go({}, n)).code, n.calls.length], [2, 0]);
});
