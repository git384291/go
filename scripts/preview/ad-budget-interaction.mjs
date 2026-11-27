// PM 11/21: 광고 예산 화면(AdBudgetView + 조작 컴포넌트)을 실제 브라우저에서 조작해 검수한다. Next.js 없이 esbuild로 묶고 API는 가짜 응답만 준다.
// 확인: 한도 상한을 넘는 입력은 승인 버튼이 열리지 않음, 승인·철회·지출 판정 요청 본문, 차단·허용 표시, 검토자 화면에는 조작 없음, 외부 요청 0.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://ads.test';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`);
}
const ROWS = [
  { id: '10000000-0000-4000-8000-000000000001', campaign_key: 'sample-camp', state: 'active', daily_cap_krw: 10000, total_cap_krw: 30000, valid_until: '2026-11-23T09:00:00Z', reason: '시험 승인', created_at: '2026-11-21T09:00:00Z', revoke_reason: null, spent_today: 4000, spent_total: 4000 },
  { id: '10000000-0000-4000-8000-000000000002', campaign_key: 'old-camp', state: 'revoked', daily_cap_krw: 5000, total_cap_krw: 12000, valid_until: '2026-11-22T09:00:00Z', reason: '이전 승인', created_at: '2026-11-20T09:00:00Z', revoke_reason: '교체', spent_today: 0, spent_total: 5000 },
];
async function bundle(role) {
  const entry = `import { createRoot } from 'react-dom/client';
    import { AdBudgetView } from './src/app/admin/ads/AdBudgetView';
    createRoot(document.getElementById('root')).render(<AdBudgetView items={${JSON.stringify(ROWS)}} role=${JSON.stringify(role)} caps={{ dailyKrw: 10000, totalKrw: 30000 }} />);`;
  const out = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'ads-entry.tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  return out.outputFiles[0].text;
}
async function open(browser, role, api) {
  const js = await bundle(role);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], api: [], pageErrors: [] };
  page.on('pageerror', (e) => seen.pageErrors.push(e.message.split('\n')[0]));
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) { seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/a.js"></script>' });
    if (u.pathname === '/a.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (u.pathname === '/api/admin/ads/budget') { const body = JSON.parse(req.postData() ?? '{}'); seen.api.push(body); return api(route, body); }
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('table');
  return { page, ctx, seen };
}
const reply = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function scenarioOwner(browser) {
  const { page, ctx, seen } = await open(browser, 'owner', (route, body) =>
    body.action === 'request' ? (body.amountKrw === 1000 ? reply(200, { ok: true, decision: 'ALLOW' })(route) : reply(200, { ok: false, decision: 'BLOCK', reason: 'DAILY_CAP_EXCEEDED' })(route)) : reply(403, { ok: false, code: 'FORBIDDEN' })(route));
  check('B1 실제 집행 없음 안내와 승인 내역(지출 합계)이 보임', (await page.getByText('실제 광고 집행은 연결되어 있지 않습니다.').count()) >= 1 && (await page.getByText('4,000원 / 4,000원').count()) === 1);
  const approve = page.getByRole('button', { name: '승인', exact: true });
  check('B2 처음에는 승인 버튼 잠김', await approve.isDisabled());
  await page.fill('input[aria-label="캠페인 키"]', 'camp-x');
  await page.fill('input[aria-label="일 한도(원)"]', '10001');
  await page.fill('input[aria-label="총 한도(원)"]', '20000');
  await page.fill('input[aria-label="승인 사유"]', '시험 승인');
  check('B3 일 한도 상한(10,000원) 초과 입력은 승인 잠김', await approve.isDisabled());
  await page.fill('input[aria-label="일 한도(원)"]', '5000');
  await page.fill('input[aria-label="총 한도(원)"]', '4000');
  check('B4 총 한도가 일 한도보다 작으면 잠김', await approve.isDisabled());
  await page.fill('input[aria-label="총 한도(원)"]', '30001');
  check('B5 총 한도 상한(30,000원) 초과 잠김', await approve.isDisabled());
  await page.fill('input[aria-label="총 한도(원)"]', '15000');
  check('B6 올바른 입력이면 승인 열림, 요청 아직 0회', !(await approve.isDisabled()) && seen.api.length === 0);
  await approve.click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="예산 승인"] [role=status]')?.textContent?.includes('거부됨'));
  const a = seen.api[0];
  check('B7 승인 요청 본문(서버가 거절하면 거절만 표시)', a.action === 'approve' && a.campaign === 'camp-x' && a.dailyCapKrw === 5000 && a.totalCapKrw === 15000 && a.hours === 24 && a.reason === '시험 승인', JSON.stringify(a));
  await page.fill('input[aria-label="캠페인 키(판정)"]', 'camp-x');
  await page.fill('input[aria-label="금액(원)"]', '1000');
  await page.getByRole('button', { name: '판정' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="지출 판정 시험"] [role=status]')?.textContent?.includes('허용'));
  const s = seen.api[1];
  check('B8 지출 판정 본문: 금액·캠페인·요청 키(고유값), 허용 표시', s.action === 'request' && s.amountKrw === 1000 && /^[A-Za-z0-9-]{16,64}$/.test(s.requestKey));
  await page.fill('input[aria-label="금액(원)"]', '9000');
  await page.getByRole('button', { name: '판정' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="지출 판정 시험"] [role=status]')?.textContent?.includes('차단됨'));
  check('B9 차단 응답은 사유와 함께 차단됨 표시, 요청 키는 매번 다름', (await page.textContent('section[aria-label="지출 판정 시험"] [role=status]')).includes('DAILY_CAP_EXCEEDED') && seen.api[1].requestKey !== seen.api[2].requestKey);
  await page.fill('input[aria-label="철회 사유"]', '교체');
  await page.getByRole('button', { name: '철회' }).click();
  await page.waitForTimeout(150);
  check('B10 철회 본문: action·캠페인·사유', seen.api[3].action === 'revoke' && seen.api[3].campaign === 'sample-camp' && seen.api[3].reason === '교체');
  check('B11 외부 요청 0·페이지 예외 0·가로 넘침 없음', seen.external.length === 0 && seen.pageErrors.length === 0 && (await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
  await ctx.close();
}
async function scenarioReviewer(browser) {
  const { page, ctx, seen } = await open(browser, 'reviewer', reply(403, { ok: false }));
  check('B12 검토자 화면: 승인·철회·판정 조작 없음(조회만)', (await page.locator('input').count()) === 0 && (await page.locator('button').count()) === 0 && (await page.getByText('조회만 가능').count()) === 1 && seen.api.length === 0);
  await ctx.close();
}
const browser = await chromium.launch();
try {
  for (const s of [scenarioOwner, scenarioReviewer]) {
    try { await s(browser); } catch (e) { check(`${s.name} 실행 중 예외 없음`, false, String(e.message).split('\n')[0]); }
  }
} finally { await browser.close(); }
const fail = results.filter((r) => !r.pass).length;
console.log(`== 광고 예산 화면 상호작용 검수: pass=${results.length - fail} fail=${fail}`);
process.exit(fail === 0 && results.length > 0 ? 0 : 1);
