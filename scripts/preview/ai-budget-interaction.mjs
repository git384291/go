// PM 11/21: AI 월 한도 화면·광고 중지 경고 해결을 실제 브라우저에서 조작해 검수(API는 가짜 응답). 외부 요청 0.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test-results/screens');
mkdirSync(OUT, { recursive: true });
const ORIGIN = 'http://aibudget.test';
const results = [];
const check = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`); };
const AID = '20000000-0000-4000-8000-000000000001';
const ALERTS = [{ id: AID, campaign_key: 'sample-camp', state: 'open', detail: { revoked: true, paused: false }, created_at: '2026-11-21T09:10:00Z', resolved_at: null, resolve_note: null }];
async function bundle(entry) {
  return (await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'f.tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;
}
const aiEntry = (role) => `import { createRoot } from 'react-dom/client';
  import { AiBudgetView } from './src/app/admin/ai-budget/AiBudgetView';
  createRoot(document.getElementById('root')).render(<AiBudgetView data={{ role: ${JSON.stringify(role)}, month: '2026-11', limitKrw: 0, usedKrw: 0, unconfirmed: 0, maxLimitKrw: 100000 }} />);`;
const fnEntry = `import { createRoot } from 'react-dom/client';
  import { FunnelView } from './src/app/admin/ads/funnel/FunnelView';
  createRoot(document.getElementById('root')).render(<FunnelView items={[]} role="owner" from="2026-11-15" to="2026-11-21" alerts={${JSON.stringify(ALERTS)}} />);`;
async function open(browser, entry, handlers) {
  const js = await bundle(entry);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], api: [], errors: [] };
  page.on('pageerror', (e) => seen.errors.push(e.message.split('\n')[0]));
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin !== ORIGIN) { seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/a.js"></script>' });
    if (u.pathname === '/a.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (handlers[u.pathname]) { const b = JSON.parse(req.postData() ?? '{}'); seen.api.push(b); return handlers[u.pathname](route, b); }
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('main');
  return { page, ctx, seen };
}
const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const browser = await chromium.launch();
try {
  // 대표: 한도 설정
  const o = await open(browser, aiEntry('owner'), { '/api/admin/ai/budget': (route, b) => (b.limitKrw === 5000 ? json(200, { ok: true })(route) : json(422, { ok: false, code: 'INVALID_LIMIT' })(route)) });
  const { page, seen } = o;
  const text = await page.innerText('main');
  check('A1 기본 한도 0원·실제 AI 미연결 안내·미정산 표시', (await page.textContent('[data-field="limit"]')) === '0원' && text.includes('실제 AI API는 연결되어 있지 않습니다') && (await page.textContent('[data-field="unconfirmed"]')).includes('0건'));
  await page.screenshot({ path: `${OUT}/36-ai-budget-owner-w390.png`, fullPage: true });
  const save = page.getByRole('button', { name: '저장' });
  check('A2 사유가 없으면 저장 잠김', await save.isDisabled());
  await page.fill('input[aria-label="변경 사유"]', '개발용 모의 시험');
  await page.fill('input[aria-label="월 한도(원)"]', '100001');
  check('A3 상한(100,000원) 초과는 저장 잠김', await save.isDisabled());
  await page.fill('input[aria-label="월 한도(원)"]', '7000');
  await save.click();
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('거부됨'));
  check('A4 서버 거부 사유를 그대로 표시, 요청 본문은 고정 필드 2개', (await page.textContent('[role="status"]')).includes('INVALID_LIMIT') && JSON.stringify(Object.keys(seen.api[0]).sort()) === JSON.stringify(['limitKrw', 'reason']));
  check('A5 외부 요청 0·페이지 오류 0·가로 넘침 없음', seen.external.length === 0 && seen.errors.length === 0 && (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)));
  await o.ctx.close();
  // 검토자: 조회만
  const r = await open(browser, aiEntry('reviewer'), {});
  check('A6 검토자는 설정 입력 없음(조회만)', (await r.page.locator('input').count()) === 0 && (await r.page.innerText('main')).includes('조회만 가능'));
  await r.ctx.close();
  // 광고 중지 실패 경고 해결
  const f = await open(browser, fnEntry, { '/api/admin/ads/run': (route, b) => json(200, { ok: true })(route) });
  const ft = await f.page.innerText('main');
  check('A7 경고 표시: 캠페인·철회 완료·플랫폼 중지 실패·차단 안내', ft.includes('광고 중지 실패 경고 1건') && ft.includes('sample-camp') && ft.includes('승인 철회 완료') && ft.includes('플랫폼 중지 실패') && ft.includes('모두 차단'));
  await f.page.screenshot({ path: `${OUT}/37-ad-stop-alert-w390.png`, fullPage: true });
  const res = f.page.getByRole('button', { name: '해결 처리' });
  check('A8 사유 없이는 해결 처리 잠김', await res.isDisabled());
  await f.page.fill('input[aria-label="해결 사유"]', '플랫폼에서 직접 중지 확인');
  f.page.on('framenavigated', () => {});
  await f.page.evaluate(() => { try { Object.defineProperty(window.location, 'reload', { value: () => { window.__reloaded = true; } }); } catch { /* 일부 브라우저는 덮어쓰기 불가 */ } });
  await res.click();
  await f.page.waitForFunction(() => true);
  await new Promise((r2) => setTimeout(r2, 300));
  check('A9 해결 요청 본문 = action·id·note, 외부 요청 0', f.seen.api.length === 1 && JSON.stringify(Object.keys(f.seen.api[0]).sort()) === JSON.stringify(['action', 'id', 'note']) && f.seen.api[0].action === 'alert_resolve' && f.seen.api[0].id === AID && f.seen.external.length === 0 && f.seen.errors.length === 0);
  await f.ctx.close();
} finally { await browser.close(); }
const bad = results.filter((x) => !x).length;
console.log(`ai-budget-interaction: ${results.length - bad}/${results.length} 통과`);
process.exit(bad ? 1 : 0);
