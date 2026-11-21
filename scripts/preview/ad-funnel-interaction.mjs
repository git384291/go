// PM 11/21: 광고 성과·모의 집행 화면을 실제 브라우저에서 조작해 검수한다(API는 가짜 응답). 외부 요청 0.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test-results/screens');
mkdirSync(OUT, { recursive: true });
const ORIGIN = 'http://funnel.test';
const results = [];
const check = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`); };
const ITEMS = [{ campaign: 'sample-camp', impressions: 1800, clicks: 60, costKrw: 600, ledgerKrw: 500, leads: 3, overspendDays: 1, clickRate: 0.0333, leadRate: 0.05, costPerLeadKrw: 200, overBudget: true }, { campaign: 'naver-brand', impressions: 2400, clicks: 96, costKrw: 960, ledgerKrw: 1000, leads: 4, overspendDays: 0, clickRate: 0.04, leadRate: 0.0417, costPerLeadKrw: 240, overBudget: false }];
async function bundle(role) {
  const entry = `import { createRoot } from 'react-dom/client';
    import { FunnelView } from './src/app/admin/ads/funnel/FunnelView';
    createRoot(document.getElementById('root')).render(<FunnelView items={${JSON.stringify(ITEMS)}} role=${JSON.stringify(role)} from="2026-11-15" to="2026-11-21" />);`;
  return (await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'f.tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;
}
async function open(browser, role, handler) {
  const js = await bundle(role);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], api: [], errors: [] };
  page.on('pageerror', (e) => seen.errors.push(e.message.split('\n')[0]));
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin !== ORIGIN) { seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/a.js"></script>' });
    if (u.pathname === '/a.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (u.pathname === '/api/admin/ads/run') { const b = JSON.parse(req.postData() ?? '{}'); seen.api.push(b); return handler(route, b); }
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('table');
  return { page, ctx, seen };
}
const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const browser = await chromium.launch();
try {
  const o = await open(browser, 'owner', (route, b) => b.action === 'launch'
    ? (b.amountKrw === 500 ? json(200, { ok: true, decision: 'ALLOW', executed: false, simulated: true, externalId: 'mock-1' })(route) : json(200, { ok: false, decision: 'BLOCK', reason: 'NO_APPROVAL' })(route))
    : json(200, { ok: true, recorded: b.day === '2026-11-20', overLedger: true, source: 'mock' })(route));
  const { page, seen } = o;
  const text = await page.innerText('main');
  check('F1 분석 표: 노출·클릭·접수·접수당 비용, 점검 열에 승인 밖 지출 의심 표시', text.includes('1,800') && text.includes('3.3%') && text.includes('200원') && text.includes('승인 밖 지출 의심 1일') && text.includes('정상'));
  check('F2 실제 집행 없음·상담 단계 미집계 안내', text.includes('실제 광고 집행·과금은 연결되어 있지 않습니다') && text.includes('상담 시작 단계는 아직 집계하지 않습니다'));
  await page.screenshot({ path: `${OUT}/28-ad-funnel-owner-w390.png`, fullPage: true });
  const launch = page.getByRole('button', { name: '모의 집행 요청' });
  const collect = page.getByRole('button', { name: '성과 수집' });
  check('F3 처음에는 두 버튼 잠김', (await launch.isDisabled()) && (await collect.isDisabled()));
  await page.fill('input[aria-label="캠페인 키(집행)"]', 'camp-x');
  await page.fill('input[aria-label="집행 금액(원)"]', '10001');
  check('F4 금액 상한(10,000원) 초과는 집행 버튼 잠김', await launch.isDisabled());
  await page.fill('input[aria-label="집행 금액(원)"]', '1000');
  await launch.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="집행 결과"]')?.textContent?.includes('차단됨'));
  check('F5 서버 차단 사유(NO_APPROVAL)를 그대로 표시, 요청 본문 고정 필드', (await page.textContent('[aria-label="집행 결과"]')).includes('NO_APPROVAL') && JSON.stringify(Object.keys(seen.api[0]).sort()) === JSON.stringify(['action', 'amountKrw', 'campaign', 'requestKey']));
  await page.fill('input[aria-label="집행 금액(원)"]', '500');
  await launch.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="집행 결과"]')?.textContent?.includes('허용됨'));
  check('F6 허용돼도 "실제 집행 없음" 표시, 요청 키는 매번 다름', (await page.textContent('[aria-label="집행 결과"]')).includes('실제 집행 없음') && seen.api[0].requestKey !== seen.api[1].requestKey);
  await page.fill('input[aria-label="수집 날짜"]', '2026-11-20');
  await collect.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="수집 결과"]')?.textContent?.includes('수집됨'));
  check('F7 수집 결과: 승인 원장보다 크면 점검 필요 표시', (await page.textContent('[aria-label="수집 결과"]')).includes('점검 필요'));
  await page.fill('input[aria-label="수집 날짜"]', '2026-11-19');
  await collect.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="수집 결과"]')?.textContent?.includes('이미 수집'));
  await page.screenshot({ path: `${OUT}/29-ad-funnel-after-actions-w390.png`, fullPage: true });
  check('F8 외부 요청 0·예외 0·가로 넘침 없음', seen.external.length === 0 && seen.errors.length === 0 && (await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
  await o.ctx.close();
  const r = await open(browser, 'reviewer', json(403, { ok: false }));
  check('F9 검토자 화면: 입력·버튼 없음(조회만), 요청 0', (await r.page.locator('input').count()) === 0 && (await r.page.locator('button').count()) === 0 && r.seen.api.length === 0 && (await r.page.getByText('조회만 가능').count()) === 1);
  await r.ctx.close();
} catch (e) { check('실행 중 예외 없음', false, String(e.message).split('\n')[0]); } finally { await browser.close(); }
const fail = results.filter((x) => !x).length;
console.log(`== 광고 성과 화면 상호작용 검수: pass=${results.length - fail} fail=${fail}`);
process.exit(fail === 0 && results.length > 0 ? 0 : 1);
