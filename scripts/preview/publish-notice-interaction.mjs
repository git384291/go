// PM 11/21: 정책 게시 스위치와 필수 고지 입력 화면을 실제 브라우저에서 조작해 검수한다(Next 없이 esbuild 번들, 가상 주소, API는 가로채기).
// 확인: 사유 없으면 버튼 잠김, 요청 본문의 키가 정확함, 서버가 거절하면 거절만 표시, 고지 입력란은 비어 있음, 입력해도 "접수 차단 유지" 문구 유지, 외부 요청 0.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://pubnotice.test';
const results = [];
const check = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`); };

async function bundle(jsx, imp) {
  const entry = `import { createRoot } from 'react-dom/client'; ${imp}\ncreateRoot(document.getElementById('root')).render(${jsx});`;
  const out = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'e.tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  return out.outputFiles[0].text;
}
async function open(browser, js, wait) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], api: [], errors: [] };
  page.on('pageerror', (e) => seen.errors.push(e.message.split('\n')[0]));
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin !== ORIGIN) { seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/p.js"></script>' });
    if (u.pathname === '/p.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (u.pathname.startsWith('/api/admin/')) { seen.api.push({ path: u.pathname, body: JSON.parse(req.postData() ?? '{}') }); return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'FORBIDDEN' }) }); }
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`); await page.waitForSelector(wait);
  return { page, ctx, seen };
}

const browser = await chromium.launch();
try {
  // 게시 스위치
  const pubJs = (role, on) => bundle(`<PublishPanel enabled={${on}} canChange={${role === 'owner'}} />`, "import { PublishPanel } from './src/app/admin/policies/PolicyConsole';");
  let { page, ctx, seen } = await open(browser, await pubJs('owner', false), '[data-field=publish]');
  const btn = page.getByRole('button', { name: '게시 켜기' });
  check('B1 대표 화면: 현재 꺼짐 표시, 사유 없으면 버튼 잠김', (await page.textContent('[data-field=publish]')).includes('꺼짐') && (await btn.isDisabled()));
  await page.fill('input[aria-label="게시 변경 사유"]', '검수 시험');
  check('B2 사유 입력 후 버튼 열림, 클릭 전 요청 0회', !(await btn.isDisabled()) && seen.api.length === 0);
  await btn.click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('거부됨'));
  check('B3 요청 본문은 enabled·reason 두 키뿐, 서버 거절은 거절만 표시', seen.api.length === 1 && seen.api[0].path === '/api/admin/policies/publish' && JSON.stringify(Object.keys(seen.api[0].body).sort()) === '["enabled","reason"]' && seen.api[0].body.enabled === true && (await page.textContent('[role=status]')).includes('FORBIDDEN'));
  check('B4 외부 요청 0, 페이지 오류 0', seen.external.length === 0 && seen.errors.length === 0, seen.external.join(','));
  await ctx.close();
  ({ page, ctx, seen } = await open(browser, await pubJs('reviewer', true), '[data-field=publish]'));
  check('B5 검토자 화면: 켜짐 표시, 변경 버튼·입력란 없음', (await page.textContent('[data-field=publish]')).includes('켜짐') && (await page.getByRole('button').count()) === 0 && (await page.locator('input').count()) === 0);
  await ctx.close();
  // 고지 입력
  const nJs = await bundle(`<NoticesView rows={[]} role="owner" status={{ ready: false, reason: 'NOTICE_NOT_CONFIRMED', codeVersion: '', mismatches: [] }} />`, "import { NoticesView } from './src/app/admin/notices/NoticesView';");
  ({ page, ctx, seen } = await open(browser, nJs, '[data-field=intake]'));
  const save = page.getByRole('button', { name: '저장' });
  const empty = (await page.inputValue('input[aria-label="고지 버전"]')) === '' && (await page.inputValue('textarea[aria-label="고지 문구"]')) === '';
  check('N1 고지 입력란은 비어 있음(임의 문구 없음), 저장 잠김, 접수 차단 유지 표시', empty && (await save.isDisabled()) && (await page.textContent('[data-field=intake]')).includes('접수 차단 유지'));
  await page.fill('input[aria-label="고지 버전"]', '잘못된 버전!'); await page.fill('input[aria-label="항목 키"]', 'collection_purpose'); await page.fill('textarea[aria-label="고지 문구"]', '[시험 문구]'); await page.fill('input[aria-label="입력 사유"]', '검수');
  check('N2 버전 형식이 틀리면 저장 잠김', await save.isDisabled());
  await page.fill('input[aria-label="고지 버전"]', 'preview-v1');
  check('N3 모든 항목이 맞으면 저장 열림, 클릭 전 요청 0회', !(await save.isDisabled()) && seen.api.length === 0);
  await save.click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="고지 문구 입력"] [role=status]')?.textContent?.includes('거부됨'));
  const b = seen.api[0]?.body ?? {};
  check('N4 요청 본문 키 정확(version·key·body·reason), 서버 거절만 표시, 접수 차단 문구 유지', seen.api.length === 1 && seen.api[0].path === '/api/admin/notices' && JSON.stringify(Object.keys(b).sort()) === '["body","key","reason","version"]' && (await page.textContent('[data-field=intake]')).includes('접수 차단 유지'));
  check('N5 외부 요청 0, 페이지 오류 0', seen.external.length === 0 && seen.errors.length === 0);
  await ctx.close();
  const rJs = await bundle(`<NoticesView rows={[]} role="reviewer" status={{ ready: false, reason: 'NOTICE_NOT_CONFIRMED', codeVersion: '', mismatches: [] }} />`, "import { NoticesView } from './src/app/admin/notices/NoticesView';");
  ({ page, ctx } = await open(browser, rJs, '[data-field=intake]'));
  check('N6 검토자 화면: 입력란·저장 버튼 없음(조회만)', (await page.locator('textarea').count()) === 0 && (await page.getByRole('button', { name: '저장' }).count()) === 0);
  await ctx.close();
} finally { await browser.close(); }
const bad = results.filter((x) => !x).length;
console.log(`== 게시·고지 화면 조작: pass=${results.length - bad} fail=${bad}`);
process.exit(bad === 0 ? 0 : 1);
