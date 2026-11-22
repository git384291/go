// PM 11/21: AI 상담창(ConsultAiChat)을 실제 브라우저에서 조작해 검수한다. API는 가짜 응답만 준다(실제 AI·네트워크 없음).
// 확인: 빈 글·301자 보내기 잠김, 요청 본문(상품 고정 코드+글), 승인 안내 표시, 서버 오류·형식 밖 응답은 안전 안내문, 외부 요청 0, 가로 넘침 없음. 화면 캡처는 test-results/screens에 저장.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test-results/screens');
mkdirSync(OUT, { recursive: true });
const ORIGIN = 'http://chat.test';
const TS_HOST = 'challenges.cloudflare.com';
// 가짜 Turnstile(PM 11/22 F1): 렌더·재발급마다 토큰을 자동 발급한다. 실제 Cloudflare 접속 없음
const FAKE_TURNSTILE = `(function () { var st = window.__ts = { renders: 0, issued: 0, opts: null }; function issue() { setTimeout(function () { st.issued++; st.opts && st.opts.callback('auto-tok-' + st.issued); }, 10); }
  window.turnstile = { render: function (el, opts) { st.renders++; st.opts = opts; issue(); return 'w' + st.renders; }, reset: function () { issue(); }, remove: function () {} }; })();`;
const results = [];
const check = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`); };
const entry = `import { createRoot } from 'react-dom/client';
  import { ConsultAiChat } from './src/components/ConsultAiChat';
  createRoot(document.getElementById('root')).render(<ConsultAiChat choice={{ carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' }} />);`;
const js = (await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'chat-entry.tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY': '"test-only-site-key"' } })).outputFiles[0].text;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  const seen = { external: [], api: [], errors: [] };
  page.on('pageerror', (e) => seen.errors.push(e.message.split('\n')[0]));
  let mode = 'ok';
  const TOKEN = `${'a1'.repeat(16)}.1893456000.${'b2'.repeat(32)}`;
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.host === TS_HOST && u.pathname === '/turnstile/v0/api.js') return route.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE });
    if (u.origin !== ORIGIN) { seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/a.js"></script>' });
    if (u.pathname === '/a.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (u.pathname === '/api/consult/chat') {
      seen.api.push(JSON.parse(req.postData() ?? '{}'));
      if (mode === 'ok') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, kind: 'quote', source: 'model', next: 'signup', text: '월 11,111원(가상 승인 안내)\n- 사은품: 3,333원 상품권', session: TOKEN }) });
      if (mode === 'down') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'DISABLED' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"text":123}' });
    }
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('textarea');
  const send = page.getByRole('button', { name: '보내기' });
  const box = page.locator('textarea[aria-label="상담 내용"]');
  check('C1 처음에는 보내기 잠김, AI 안내·개인정보 주의 문구 표시', (await send.isDisabled()) && (await page.getByText('사람 상담원이 아닙니다').count()) >= 1 && (await page.getByText('이름·전화번호·주소는 여기에 적지 마세요').count()) === 1);
  await box.fill('   ');
  check('C2 공백만 있으면 잠김', await send.isDisabled());
  await box.evaluate((el) => { el.removeAttribute('maxlength'); });
  await box.fill('가'.repeat(301));
  check('C3 301자는 잠김(300자 제한)', await send.isDisabled());
  await page.screenshot({ path: `${OUT}/22-consult-ai-empty-w390.png`, fullPage: true });
  await box.fill('요금이 얼마예요?');
  check('C4 정상 글이면 열림, 요청 아직 0회', !(await send.isDisabled()) && seen.api.length === 0);
  await send.click();
  await page.waitForSelector('[data-from="ai"]');
  const b = seen.api[0];
  check('C5 요청 본문: 고정 코드 3개 + 글 + 첫 요청엔 세션 대신 1회용 봇 확인 토큰(서버가 세션 발급, 키·모델·개인정보 필드 없음)', JSON.stringify(Object.keys(b).sort()) === JSON.stringify(['carrier', 'message', 'productId', 'regionCode', 'turnstileToken']) && b.message === '요금이 얼마예요?' && b.carrier === 'carrier-x' && b.turnstileToken === 'auto-tok-1');
  check('C6 승인 안내가 AI 도우미 말풍선에 표시, 입력칸 비워짐', (await page.locator('[data-from="ai"]').innerText()).includes('11,111원') && (await box.inputValue()) === '');
  await page.screenshot({ path: `${OUT}/23-consult-ai-answer-w390.png`, fullPage: true });
  mode = 'down'; await box.fill('또 질문'); await send.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-from="ai"]').length === 2);
  check('C6b 두 번째 요청은 서버가 내려 준 세션 토큰을 그대로 보냄(브라우저가 만들지 않음)', seen.api[1]?.session === TOKEN);
  const safe = await page.locator('[data-from="ai"]').nth(1).innerText();
  check('C7 서버 장애(503)는 안전 안내문, 내부 코드 노출 없음', safe.includes('담당자가 확인한 뒤') && !safe.includes('DISABLED'));
  mode = 'bad'; await box.fill('형식 밖'); await send.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-from="ai"]').length === 3);
  check('C8 형식 밖 응답도 안전 안내문', (await page.locator('[data-from="ai"]').nth(2).innerText()).includes('담당자가 확인한 뒤'));
  await page.screenshot({ path: `${OUT}/24-consult-ai-fallback-w390.png`, fullPage: true });
  check('C9 신청 링크는 같은 화면의 접수 양식으로 이동', (await page.getByRole('link', { name: '가입 상담 신청하기' }).getAttribute('href')) === '#apply');
  check('C10 외부 요청 0·예외 0·가로 넘침 없음', seen.external.length === 0 && seen.errors.length === 0 && (await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
  // BT: 봇 확인 오류·만료 안내와 재시도(PM 11/23 P2). 우회 없음: 토큰이 없으면 글이 있어도 잠김
  {
    const p2 = await ctx.newPage();
    const n0 = seen.api.length;
    await p2.goto(`${ORIGIN}/`);
    await p2.waitForSelector('textarea');
    await p2.waitForFunction(() => window.__ts && window.__ts.issued >= 1);
    const s2 = p2.getByRole('button', { name: '보내기' });
    const b2 = p2.locator('textarea[aria-label="상담 내용"]');
    await b2.fill('요금 문의');
    await p2.waitForFunction(() => !document.querySelector('button[disabled]'));
    await p2.evaluate(() => window.__ts.opts['error-callback']());
    await p2.waitForSelector('[data-bot-status="error"]');
    check('BT1 오류: 안내 문구와 다시 확인 버튼 표시, 보내기 잠김(우회 없음), 요청 0회', (await s2.isDisabled()) && (await p2.getByRole('alert').innerText()).includes('오류') && (await p2.getByRole('button', { name: '다시 확인' }).count()) === 1 && seen.api.length === n0);
    await p2.getByRole('button', { name: '다시 확인' }).click();
    await p2.waitForFunction(() => document.querySelector('[data-bot-status]') === null);
    await p2.waitForFunction(() => !document.querySelector('button[disabled]'));
    check('BT2 다시 확인 후 새 토큰으로 열리고 안내 사라짐', !(await s2.isDisabled()));
    await p2.evaluate(() => window.__ts.opts['expired-callback']());
    await p2.waitForSelector('[data-bot-status="expired"]');
    check('BT3 만료: 안내 표시, 보내기 잠김', (await s2.isDisabled()) && (await p2.getByRole('alert').innerText()).includes('시간이 지났'));
    await p2.getByRole('button', { name: '다시 확인' }).click();
    await p2.waitForFunction(() => !document.querySelector('button[disabled]'));
    check('BT4 만료 후 재시도로 복구, 안내 사라짐', (await p2.locator('[data-bot-status]').count()) === 0 && !(await s2.isDisabled()));
    await p2.close();
  }
  await ctx.close();
} catch (e) { check('실행 중 예외 없음', false, String(e.message).split('\n')[0]); } finally { await browser.close(); }
const fail = results.filter((r) => !r).length;
console.log(`== AI 상담창 상호작용 검수: pass=${results.length - fail} fail=${fail}`);
process.exit(fail === 0 && results.length > 0 ? 0 : 1);
