// PM 11/21: 승인된 고지가 고객 화면(ConsultForm)에 글자 그대로 표시되는지 실제 브라우저로 확인한다(Next·서버·DB 없음, 외부 요청 차단).
// 시험용 가상 문구(줄바꿈·<>&"' 포함)를 확정 설정으로 끼워 넣어 제목·본문·항목 수·버전이 그대로인지, 미확정(실제 설정)이면 문구가 하나도 보이지 않는지 본다.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://notice.test';
const results = [];
const check = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`); };

const ITEMS = [
  { key: 'collection_purpose', title: '수집·이용 목적 [시험]', body: '1) 수집 항목: 이름 <b>·</b> 연락처 & "상담 시간"\n2) 보유 기간: 접수일부터 1년\n\n※ 검수용 가상 문구 — 실제 고지 아님' },
  { key: 'not_a_contract', title: '계약 아님 안내 [시험]', body: '이 신청은 가입 계약이 아닙니다.   (공백 세 칸 유지)' },
];
async function bundle(fake) {
  const entry = `import { createRoot } from 'react-dom/client'; import { ConsultForm } from './src/components/ConsultForm';
createRoot(document.getElementById('root')).render(<ConsultForm options={[{ value: 'internet_tv', label: '인터넷+TV' }]} kakaoUrl={null} />);`;
  const out = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'n.tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    plugins: fake ? [{ name: 'fake-notices', setup(b) {
      b.onResolve({ filter: /content\/requiredNotices$/ }, (a) => (a.importer.endsWith('ConsultForm.tsx') ? { path: 'fake', namespace: 'fn' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'fn' }, () => ({ loader: 'ts', contents: `export const REQUIRED_NOTICES = { version: 'privacy-test-v1', confirmed: true, items: ${JSON.stringify(ITEMS)} };
export function noticeReadiness(cfg, v) { return cfg.confirmed && cfg.version === v && v !== '' ? { ready: true } : { ready: false, reason: 'X' }; }` }));
    } }] : [],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_LEAD_FORM_ENABLED': '"true"', 'process.env.NEXT_PUBLIC_PRIVACY_POLICY_VERSION': '"privacy-test-v1"', 'process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY': '"site-key-test"' },
  });
  return out.outputFiles[0].text;
}
async function open(browser, js) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], posts: 0, errors: [] };
  page.on('pageerror', (e) => seen.errors.push(e.message.split('\n')[0]));
  await ctx.route('**/*', (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin !== ORIGIN) { if (u.host !== 'challenges.cloudflare.com') seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (req.method() === 'POST') seen.posts++;
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/p.js"></script>' });
    if (u.pathname === '/p.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`); await page.waitForSelector('.consent-box[aria-label="필수 고지"]');
  return { page, ctx, seen };
}
const browser = await chromium.launch();
try {
  let { page, ctx, seen } = await open(browser, await bundle(true));
  const box = page.locator('.consent-box[aria-label="필수 고지"]');
  const titles = await box.locator('summary').allTextContents();
  const bodies = await box.locator('details > p').evaluateAll((els) => els.map((e) => ({ t: e.textContent, ws: getComputedStyle(e).whiteSpace, html: e.innerHTML.includes('<b>') })));
  check('D1 확정 고지: 제목이 승인 문구 그대로, 항목 수·순서 동일', JSON.stringify(titles) === JSON.stringify(ITEMS.map((i) => i.title)));
  check('D2 본문이 한 글자도 바뀌지 않음(줄바꿈·공백 세 칸·<>&"\' 포함), HTML로 해석되지 않음', bodies.length === 2 && bodies.every((b, i) => b.t === ITEMS[i].body && !b.html));
  check('D3 줄바꿈·공백 보존 스타일(pre-wrap) 적용', bodies.every((b) => b.ws === 'pre-wrap'));
  const labels = await box.locator('label.check span').allTextContents();
  check('D4 항목마다 [필수] 확인 체크박스 1개씩, 처음엔 모두 해제', labels.length === 2 && labels.every((l, i) => l.includes('[필수]') && l.includes(ITEMS[i].title)) && (await box.locator('input[type=checkbox]:checked').count()) === 0);
  check('D5 화면 표시만으로 요청·외부 호출·오류 0', seen.posts === 0 && seen.external.length === 0 && seen.errors.length === 0, seen.external.join(','));
  await ctx.close();
  ({ page, ctx, seen } = await open(browser, await bundle(false)));
  const real = page.locator('.consent-box[aria-label="필수 고지"]');
  check('D6 실제 설정(미확정): 고지 문구·체크박스 없이 "확정되기 전에는 상담 신청을 받지 않습니다"만 표시', (await real.locator('details').count()) === 0 && (await real.locator('input[type=checkbox]').count()) === 0 && (await real.textContent()).includes('확정되기 전에는 상담 신청을 받지 않습니다'));
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(300);
  check('D7 미확정 상태에서 제출을 눌러도 서버 요청 0건', seen.posts === 0);
  await ctx.close();
} finally { await browser.close(); }
const bad = results.filter((x) => !x).length;
console.log(`== 고지 표시 정확성: pass=${results.length - bad} fail=${bad}`);
process.exit(bad === 0 ? 0 : 1);
