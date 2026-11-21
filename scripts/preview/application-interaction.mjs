// PM 11/22: AI 신청서 도우미(ApplicationAssistant)가 붙은 상담 폼을 브라우저에서 조작해 검수한다(form-interaction과 같은 가상 환경).
// - Next.js 없이 컴포넌트만 esbuild로 묶어 가상 주소(http://form.test)에 띄운다. 서버·포트·DB 없음.
// - /api/leads와 Turnstile 스크립트는 Playwright 경로 가로채기로 가짜 응답만 준다. 실제 외부 요청은 모두 막는다.
// - 폼 켜짐/공개 키 값은 이 번들 안에서만 정의한다(실제 환경·게이트·스위치는 바꾸지 않는다).
// 실행: node scripts/preview/form-interaction.mjs   (npm run test:preview 마지막 단계)
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://form.test';
const TS_HOST = 'challenges.cloudflare.com';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`);
}

async function bundle({ enabled, siteKey, privacy = 'privacy-test-v1', dev = false }) {
  const entry = `
    import { StrictMode } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ConsultForm } from './src/components/ConsultForm';
    createRoot(document.getElementById('root')).render(
      <StrictMode><ConsultForm options={[{ value: 'internet_tv', label: '인터넷+TV' }]} kakaoUrl={null} choice={{ carrier: 'kt', productId: 'p1', regionCode: 'r1' }} /></StrictMode>
    );`;
  const out = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'form-entry.tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    // 시험 전용 확정 고지 설정으로 바꿔 끼운다(실제 설정은 미확정이라 접수를 막는다. 실제 문구 아님)
    plugins: [{
      name: 'test-notices',
      setup(b) {
        b.onResolve({ filter: /content\/requiredNotices$/ }, (a) => (a.importer.endsWith('ConsultForm.tsx') ? { path: 'test-notices', namespace: 'tn' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'tn' }, () => ({
          loader: 'ts',
          contents: `export const REQUIRED_NOTICES = { version: ${JSON.stringify(privacy)}, confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: '시험용 문구' }] };
export function noticeReadiness(cfg, v) { return cfg.confirmed && cfg.version === v && v !== '' ? { ready: true } : { ready: false, reason: 'X' }; }`,
        }));
      },
    }],
    define: {
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
      'process.env.NEXT_PUBLIC_LEAD_FORM_ENABLED': JSON.stringify(enabled ? 'true' : 'false'),
      'process.env.NEXT_PUBLIC_PRIVACY_POLICY_VERSION': JSON.stringify(privacy),
      'process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY': JSON.stringify(siteKey),
    },
  });
  return out.outputFiles[0].text;
}

// 가짜 Turnstile: 명시적 렌더 호출을 기록한다. 시나리오별 설정(window.__tsConf, addInitScript로 주입)으로
// 자동 토큰 발급(render·reset 뒤 SDK가 스스로 새 토큰을 줌)과 SDK 예외·render 실패를 흉내 낸다.
const FAKE_TURNSTILE = `
  (function () {
    var conf = window.__tsConf || {};
    var st = window.__ts = { renders: 0, resets: 0, removes: 0, renderCalls: 0, opts: null, issued: 0, loads: (window.__ts && window.__ts.loads || 0) + 1 };
    function issue() { if (!conf.auto) return; setTimeout(function () { st.issued++; st.opts && st.opts.callback('auto-tok-' + st.issued); }, 10); }
    window.turnstile = {
      render: function (el, opts) {
        st.renderCalls++;
        if (conf.renderFailTimes > 0) { conf.renderFailTimes--; if (conf.renderFailMode === 'undefined') return undefined; throw new Error('fake render failure'); }
        st.renders++; st.opts = opts; el.setAttribute('data-fake-turnstile', '1'); issue(); return 'w' + st.renders;
      },
      reset: function () { st.resets++; if (conf.resetThrows) throw new Error('fake reset failure'); issue(); },
      remove: function () { st.removes++; if (conf.removeThrows) throw new Error('fake remove failure'); },
    };
  })();`;

async function openForm(browser, { enabled, siteKey, api, clock = false, privacy, dev = false, tsConf = {}, scriptFailTimes = 0 }) {
  const js = await bundle({ enabled, siteKey, privacy, dev });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], turnstile: 0, api: [], pageErrors: [], scriptFails: 0 };
  await page.addInitScript((c) => { window.__tsConf = c; }, tsConf);
  page.on('pageerror', (e) => seen.pageErrors.push(e.message.split('\n')[0]));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.host === TS_HOST) seen.turnstile++;
    else if (u.origin !== ORIGIN) seen.external.push(u.host);
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === ORIGIN && u.pathname === '/') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/form.js"></script>' });
    }
    if (u.origin === ORIGIN && u.pathname === '/form.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (u.origin === ORIGIN && u.pathname === '/api/leads') {
      const body = JSON.parse(req.postData() ?? '{}');
      seen.api.push(body);
      return api(route, body, seen.api.length);
    }
    if (u.host === TS_HOST && u.pathname === '/turnstile/v0/api.js') {
      if (seen.scriptFails < scriptFailTimes) {
        seen.scriptFails++;
        return route.abort('failed'); // 초기 스크립트 로딩 실패
      }
      return route.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE });
    }
    return route.abort('blockedbyclient');
  });
  if (clock) await page.clock.install();
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('form.consult-form');
  return { page, ctx, seen };
}

const reply = (status, body, type = 'application/json') => (route) => route.fulfill({ status, contentType: type, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function fill(page, { name = '테스트', phone = '010-0000-0001', contact = '', consent = true } = {}) {
  await page.fill('input[name=name]', name);
  await page.fill('input[name=phone]', phone);
  await page.fill('input[name=contactTime]', contact);
  const box = page.locator('.consent-box input[type=checkbox]').first();
  if ((await box.isChecked()) !== consent) await box.click();
  const notice = page.locator('.consent-box[aria-label="필수 고지"] input[type=checkbox]');
  for (let i = 0; i < (await notice.count()); i++) if (!(await notice.nth(i).isChecked())) await notice.nth(i).click();
}
/** 제출 후 요청이 실제로 나가고(응답 처리까지) 폼이 결과 상태로 정착할 때까지 기다린다(이전 결과 문구에 속지 않게) */
async function submitAndSettle(page, seen, how = () => page.click('button[type=submit]')) {
  const before = seen.api.length;
  await how();
  const deadline = Date.now() + 20000;
  while (seen.api.length === before) {
    if (Date.now() > deadline) throw new Error('요청이 나가지 않음');
    await page.waitForTimeout(20);
  }
  await page.waitForFunction(() => !document.querySelector('form').getAttribute('aria-busy') || document.querySelector('form').getAttribute('aria-busy') === 'false');
  await page.waitForFunction(() => document.querySelector('.form-result'));
}
const token = (page, t) => page.evaluate((v) => window.__ts.opts.callback(v), t);
const resultText = (page) => page.locator('.form-result').textContent();

const answerSel = async (page, label) => page.click(`[role=group] button:has-text("${label}")`);
const browser = await chromium.launch();
try {
  const { page, ctx, seen } = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', api: reply(202, { ok: true }), tsConf: { auto: true } });
  const prog = () => page.locator('[data-field=assistant-progress]').textContent();
  check('AA1 도우미가 보이고 필수 항목이 모두 남음, 주민번호·자동이체·계좌는 묻지 않는다는 안내', (await page.locator('[aria-label="AI 신청서 도우미"]').count()) === 1 && /필수 0\/5/.test(await prog()) && (await page.locator('[aria-label="AI 신청서 도우미"]').textContent()).includes('주민등록번호'));
  // 빈 신청서로 제출 → 누락 안내, 전송 0회
  await fill(page, { name: '홍길동', phone: '010-0000-0001' });
  await page.click('button[type=submit]');
  await page.waitForTimeout(150);
  check('AA2 신청서 필수 항목 누락 시 제출 막힘(전송 0회)과 누락 목록 표시', seen.api.length === 0 && /설치 주소/.test(await page.locator('body').textContent()));
  // 민감정보 입력 거부
  for (const bad of ['900101-1234567', '110-123-456789', '자동이체 신청합니다']) {
    await page.fill('input[aria-label="설치 주소"]', bad);
    await page.click('button:has-text("답하기")');
    check(`AA3 민감정보 입력 거부(${bad.slice(0, 4)}…): 경고 표시, 답으로 저장되지 않음`, (await page.locator('[role=alert]:has-text("입력할 수 없습니다")').count()) >= 1 && /필수 0\/5/.test(await prog()));
  }
  await page.fill('input[aria-label="설치 주소"]', '서울시 가상구 시험로 12 101동 1203호');
  await page.click('button:has-text("답하기")');
  await answerSel(page, '아파트'); await answerSel(page, '본인'); await answerSel(page, 'KT'); await answerSel(page, '가능한 빨리');
  check('AA4 질문 순서대로 답하면 필수 5/5 완료 표시', /필수 5\/5/.test(await prog()), await prog());
  await page.click('[data-field=installAddress] button[aria-label$="수정"]');
  check('AA5 수정 버튼으로 답을 지우면 다시 필수 4/5, 질문이 다시 나옴', /필수 4\/5/.test(await prog()) && (await page.locator('input[aria-label="설치 주소"]').count()) === 1);
  await page.fill('input[aria-label="설치 주소"]', '서울시 가상구 시험로 12 101동 1203호');
  await page.click('button:has-text("답하기")');
  await submitAndSettle(page, seen);
  const body = seen.api[0];
  const app = body.application ?? {};
  check('AA6 제출 본문에 application이 허용된 키로만 실려 감(선택 상품 + 5개 답), 주민번호·계좌 키 없음', Object.keys(app).sort().join(',') === 'carrier,currentCarrier,housingType,installAddress,installPref,productId,regionCode,subscriberType' && app.installAddress.includes('시험로') && !JSON.stringify(body).match(/rrn|account|autopay/), Object.keys(app).join(','));
  check('AA7 제출 성공, 외부 요청 없음·페이지 오류 없음', /접수/.test(await resultText(page)) && seen.external.length === 0 && seen.pageErrors.length === 0, `${seen.external.join(',')} ${seen.pageErrors.join(',')}`);
  await ctx.close();
} catch (e) {
  check('시나리오 실행 중 예외 없음', false, String(e && e.message ? e.message.split('\n')[0] : e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`== 신청서 도우미 상호작용 검수: pass=${results.length - failed} fail=${failed}`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
