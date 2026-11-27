// PM 6907697718: 실제로 렌더링되고 이벤트가 연결된 상담 폼(ConsultForm)을 브라우저에서 조작해 검수한다.
// - Next.js 없이 컴포넌트만 esbuild로 묶어 가상 주소(http://form.test)에 띄운다. 서버·포트·DB 없음.
// - /api/leads와 Turnstile 스크립트는 Playwright 경로 가로채기로 가짜 응답만 준다. 실제 외부 요청은 모두 막는다.
// - 폼 켜짐/공개 키 값은 이 번들 안에서만 정의한다(실제 환경·게이트·스위치는 바꾸지 않는다).
// 실행: node scripts/preview/form-interaction.mjs   (npm run test:preview 마지막 단계)
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://localhost:4173'; // crypto.subtle(고지 해시 계산)은 보안 컨텍스트(https·localhost)에서만 쓸 수 있다
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
      <StrictMode><ConsultForm options={[{ value: 'internet_tv', label: '인터넷+TV' }]} kakaoUrl={null} /></StrictMode>
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

async function openForm(browser, { enabled, siteKey, api, clock = false, privacy, dev = false, tsConf = {}, scriptFailTimes = 0, status = null }) {
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
    // PM 11/24: 접수 화면 잠금용 정책 상태(서버 판정). 시나리오가 주면 그 응답, 없으면 막힘(화면 판정 보류 = 기존 동작)
    if (u.origin === ORIGIN && u.pathname === '/api/leads/status' && status) {
      seen.status = (seen.status ?? 0) + 1;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(status) });
    }
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
const focusedName = (page) => page.evaluate(() => document.activeElement?.getAttribute('name') ?? (document.activeElement?.type === 'checkbox' ? 'consent' : document.activeElement?.tagName));
const storageEmpty = (page) => page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && location.search === '' && location.hash === '');

async function scenarioMain(browser) {
  let mode = 'abort';
  const { page, ctx, seen } = await openForm(browser, {
    enabled: true,
    siteKey: 'test-only-site-key',
    api: (route) => {
      if (mode === 'abort') return route.abort('failed');
      if (mode === 'invalid_phone') return reply(400, { ok: false, code: 'INVALID_PHONE' })(route);
      if (mode === 'hostile') return reply(500, '<html><img src=x onerror=alert(1)>DB error relation pii.customers</html>', 'text/html')(route);
      return reply(202, { ok: true })(route);
    },
  });
  await page.waitForFunction(() => window.__ts && window.__ts.renders === 1);
  check('F1 위젯: StrictMode 이중 마운트에서도 명시적 렌더 1회·스크립트 1개·action=lead_form',
    (await page.evaluate(() => window.__ts.renders === 1 && document.querySelectorAll('script[src*="turnstile"]').length === 1 && window.__ts.opts.action === 'lead_form' && window.__ts.opts.sitekey === 'test-only-site-key')));

  // 빈 제출 → 필드별 오류·첫 오류 초점·API 0회
  await page.click('button[type=submit]');
  const inv = await page.evaluate(() => ['name', 'phone'].map((n) => document.querySelector(`input[name=${n}]`).getAttribute('aria-invalid')));
  const described = await page.evaluate(() => {
    const el = document.querySelector('input[name=name]');
    const id = el.getAttribute('aria-describedby');
    return !!id && !!document.getElementById(id)?.textContent;
  });
  check('F2 빈 제출: 이름·번호·동의 오류 표시, aria-invalid·오류 연결, 첫 오류(이름) 초점, 전송 0회',
    inv.every((v) => v === 'true') && described && (await page.locator('.field-error').count()) === 3 && (await focusedName(page)) === 'name' && seen.api.length === 0,
    `${inv} focus=${await focusedName(page)} api=${seen.api.length}`);

  // 번호 형식 오류 → 번호만 오류·초점, 입력 보존
  await fill(page, { phone: '02-123-4567' });
  await page.click('button[type=submit]');
  check('F3 번호 형식 오류만 남고 초점 이동, 이름 입력 보존, 전송 0회',
    (await page.locator('.field-error').count()) === 1 && (await focusedName(page)) === 'phone' && (await page.inputValue('input[name=name]')) === '테스트' && seen.api.length === 0);
  await page.fill('input[name=phone]', '010-0000-0001');
  check('F4 수정하면 해당 오류가 바로 사라짐', (await page.locator('.field-error').count()) === 0 && (await page.getAttribute('input[name=phone]', 'aria-invalid')) === null);

  // 봇 확인 전 → 전송 안 함
  await page.click('button[type=submit]');
  check('F5 봇 확인 전에는 전송하지 않음(안내만)', seen.api.length === 0 && (await resultText(page)).includes('자동 입력 방지 확인을 완료'));

  // 토큰 → 응답 유실(네트워크 실패) → 입력 보존·재시도 가능·위젯 reset
  await token(page, 'tok-1');
  await submitAndSettle(page, seen);
  const k1 = seen.api[0]?.idempotencyKey;
  // 고객이 본 고지 문구('시험용 문구')의 sha256(본문 trim, UTF-8)을 접수 본문에 싣는다(서버가 자기 상수·DB 승인 문구와 대조)
  check('F5b 접수 본문에 고객 화면이 보여 준 고지 버전·항목 키·문구 해시가 실린다', seen.api[0]?.noticeVersion === 'privacy-test-v1' && seen.api[0]?.noticeKeys?.join() === 'n1' && seen.api[0]?.noticeHashes?.n1 === createHash('sha256').update('시험용 문구', 'utf8').digest('hex'), JSON.stringify(seen.api[0]?.noticeHashes));
  check('F6 응답 유실: 결과 미확인 안내(접수 안 됨 단정 없음), 입력 보존, 전송 잠금 해제, 봇 토큰 재발급(reset) 요청',
    seen.api.length === 1 && (await resultText(page)).includes('확인하지 못했습니다') && !(await resultText(page)).includes('접수되지 않았') && (await page.inputValue('input[name=phone]')) === '010-0000-0001' &&
      !(await page.evaluate(() => document.querySelector('fieldset').disabled)) && (await page.evaluate(() => window.__ts.resets)) === 1 && seen.api[0].turnstileToken === 'tok-1');

  await page.click('button[type=submit]');
  check('F7 쓴 봇 토큰은 재사용하지 않음(새 토큰 전 전송 0회)', seen.api.length === 1);

  // 같은 내용 재시도 → 같은 키, 새 봇 토큰
  mode = 'invalid_phone';
  await token(page, 'tok-2');
  await submitAndSettle(page, seen);
  check('F8 같은 내용 재시도: 같은 요청 키·새 봇 토큰(키와 토큰 분리)', seen.api.length === 2 && seen.api[1].idempotencyKey === k1 && seen.api[1].turnstileToken === 'tok-2');
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'phone');
  check('F9 서버 번호 오류(INVALID_PHONE): 번호 칸 오류·초점, 고정 문구', (await page.getAttribute('input[name=phone]', 'aria-invalid')) === 'true' && (await focusedName(page)) === 'phone');

  // 비허용 응답(HTML 500) → 원문 반사 없음
  mode = 'hostile';
  await token(page, 'tok-3');
  await submitAndSettle(page, seen);
  const bodyText = await page.locator('body').innerText();
  check('F10 예상 못한 응답(HTML 500): 결과 미확인 고정 문구, 응답 원문·태그 반사 없음',
    (await resultText(page)).includes('확인하지 못했습니다') && !bodyText.includes('pii.customers') && (await page.locator('form img').count()) === 0 && seen.api[2].idempotencyKey === k1);

  // 내용 변경 → 새 키 → 202
  mode = 'ok';
  await page.fill('input[name=phone]', '010-0000-0002');
  await token(page, 'tok-4');
  await submitAndSettle(page, seen);
  const k4 = seen.api[3]?.idempotencyKey;
  check('F11 내용 변경 → 새 요청 키', seen.api.length === 4 && typeof k4 === 'string' && k4 !== k1);
  check('F12 202 접수: 성공 문구(가입·개통·확정 시간 약속 없음), 폼 잠금, 위젯 정리',
    (await resultText(page)).includes('접수되었습니다') && !/개통|가입 완료|확정/.test(await resultText(page)) && (await page.evaluate(() => document.querySelector('fieldset').disabled)) &&
      (await page.evaluate(() => window.__ts.removes)) >= 1);

  // 성공 후 재제출(버튼·Enter·requestSubmit) 차단
  await page.evaluate(() => { const f = document.querySelector('form'); f.requestSubmit(); f.requestSubmit(); });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('F13 성공 후 재제출(requestSubmit·Enter) 0회', seen.api.length === 4, `api=${seen.api.length}`);
  check('F14 입력·키·토큰을 저장소·URL에 남기지 않음', await storageEmpty(page));
  check('F15 가짜 경로 외 외부 요청 0, 페이지 예외 0', seen.external.length === 0 && seen.pageErrors.length === 0, [...seen.external, ...seen.pageErrors].join(','));
  check('F15b 요청 키 형식(서버 16~64자 영숫자·하이픈)', seen.api.every((b) => /^[A-Za-z0-9-]{16,64}$/.test(b.idempotencyKey)));
  await ctx.close();
}

async function scenarioDoubleSubmit(browser) {
  // 응답을 고정 시간(400ms)만 지연하면 느린 CI에서 점검 전에 응답이 도착해 aria-busy가 풀린다(F16 간헐 실패 원인). 시험이 풀어 줄 때까지 응답을 붙잡는 문(gate)으로 대체
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page, ctx, seen } = await openForm(browser, {
    enabled: true,
    siteKey: 'test-only-site-key',
    api: async (route) => {
      await gate;
      return reply(202, { ok: true })(route);
    },
  });
  await page.waitForFunction(() => window.__ts && window.__ts.renders === 1);
  await fill(page);
  await token(page, 'tok-d');
  // 같은 틱 안의 연속 제출(재렌더 전) + 더블클릭 + Enter
  await page.evaluate(() => { const f = document.querySelector('form'); f.requestSubmit(); f.requestSubmit(); f.requestSubmit(); });
  await page.dblclick('button[type=submit]', { force: true }).catch(() => {});
  await page.keyboard.press('Enter');
  // 응답은 gate로 붙잡혀 있으므로 '전송 중' 상태는 풀리지 않는다. React가 그 상태를 실제로 그릴 때까지 기다린 뒤 확인한다(즉시 읽으면 렌더 전일 수 있음 — 357af40 F16 간헐 실패)
  const busy = await page.waitForFunction(() => document.querySelector('form')?.getAttribute('aria-busy') === 'true' && document.querySelector('fieldset')?.disabled === true, null, { timeout: 5000 }).then(() => true, () => false);
  release();
  check('F16 전송 중 표시·잠금(aria-busy, fieldset disabled)', busy);
  await page.waitForFunction(() => document.querySelector('.form-result.done'));
  await page.waitForTimeout(200);
  check('F17 빠른 이중 제출·더블클릭·Enter → 요청 1회', seen.api.length === 1, `api=${seen.api.length}`);
  await ctx.close();
}

async function scenarioBotStates(browser) {
  const { page, ctx, seen } = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', api: reply(202, { ok: true }) });
  await page.waitForFunction(() => window.__ts && window.__ts.renders === 1);
  await fill(page);
  await token(page, 'tok-e');
  await page.evaluate(() => window.__ts.opts['expired-callback']());
  await page.click('button[type=submit]');
  check('F18 봇 토큰 만료: 만료 안내, 전송 0회', seen.api.length === 0 && (await page.locator('.field-hint').count()) === 1);
  await token(page, 'tok-f');
  await page.evaluate(() => window.__ts.opts['error-callback']());
  await page.click('button[type=submit]');
  check('F19 봇 확인 오류: 전송 0회', seen.api.length === 0);
  await page.evaluate(() => window.__ts.opts.callback({ not: 'a string' }));
  await page.click('button[type=submit]');
  check('F20 형식 밖 토큰 값은 무시, 전송 0회', seen.api.length === 0);
  await ctx.close();
}

async function scenarioTimeout(browser) {
  const { page, ctx, seen } = await openForm(browser, {
    enabled: true,
    siteKey: 'test-only-site-key',
    clock: true,
    api: () => new Promise(() => {}), // 응답하지 않음
  });
  await page.clock.runFor(100);
  await page.waitForFunction(() => window.__ts && window.__ts.renders === 1);
  await fill(page);
  await token(page, 'tok-t');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('fieldset').disabled);
  await page.clock.runFor(16000);
  await page.waitForFunction(() => document.querySelector('.form-result.error'));
  check('F21 응답 없음 15초 → 결과 미확인 안내, 잠금 해제, 입력 보존',
    (await resultText(page)).includes('확인하지 못했습니다') && !(await page.evaluate(() => document.querySelector('fieldset').disabled)) && (await page.inputValue('input[name=name]')) === '테스트' && seen.api.length === 1);
  await ctx.close();
}

/** PM 11/24 결정 [필수7]: 서버가 정책 상태로 접수 불가(open:false)를 알리면 접수 버튼·입력이 잠기고 B 안내가 보이며 요청 0건. open:true면 그대로 열림 */
async function scenarioPolicyBlocked(browser) {
  const closed = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', api: reply(202, { ok: true }), status: { ok: true, open: false } });
  await closed.page.waitForSelector('[data-field="policy-blocked"]', { timeout: 3000 }).catch(() => {});
  const st = await closed.page.evaluate(() => ({
    btn: document.querySelector('button[type=submit]')?.disabled === true,
    fs: document.querySelector('fieldset')?.disabled === true,
    msg: document.querySelector('[data-field="policy-blocked"]')?.textContent ?? '',
    label: document.querySelector('button[type=submit]')?.textContent ?? '',
  }));
  await closed.page.evaluate(() => document.querySelector('form').requestSubmit());
  await closed.page.waitForTimeout(300);
  check('F40 정책 접수 불가(서버 open:false): 접수 버튼·입력 잠금, B 안내 표시, 강제 제출해도 요청 0건',
    st.btn && st.fs && st.msg.includes('가입 접수를 일시적으로 제한') && st.label.includes('일시 제한') && closed.seen.api.length === 0 && closed.seen.status >= 1,
    JSON.stringify({ ...st, api: closed.seen.api.length, status: closed.seen.status }));
  await closed.ctx.close();
  const open = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', api: reply(202, { ok: true }), status: { ok: true, open: true } });
  await open.page.waitForTimeout(400);
  const o = await open.page.evaluate(() => ({ btn: document.querySelector('button[type=submit]')?.disabled === false, blocked: document.querySelectorAll('[data-field="policy-blocked"]').length }));
  check('F41 정책 접수 가능(서버 open:true): 버튼 열림, 잠금 안내 없음', o.btn && o.blocked === 0 && open.seen.status >= 1, JSON.stringify(o));
  await open.ctx.close();
}

async function scenarioClosed(browser) {
  for (const [label, enabled, siteKey] of [['폼 꺼짐(기본값)', false, ''], ['폼 꺼짐 + 키 있음', false, 'test-only-site-key'], ['폼 켜짐 + 공개 키 없음', true, '']]) {
    const { page, ctx, seen } = await openForm(browser, { enabled, siteKey, api: reply(202, { ok: true }) });
    await page.waitForTimeout(300);
    const dom = await page.evaluate(() => document.querySelectorAll('script[src*="turnstile"], iframe').length);
    if (enabled) {
      await fill(page);
      await page.click('button[type=submit]');
    } else {
      await page.evaluate(() => document.querySelector('form').requestSubmit());
    }
    await page.waitForTimeout(200);
    check(`F22 ${label}: Turnstile 스크립트·iframe·외부 요청 0, 접수 요청 0`,
      dom === 0 && seen.turnstile === 0 && seen.external.length === 0 && seen.api.length === 0,
      `dom=${dom} ts=${seen.turnstile} api=${seen.api.length}`);
    if (enabled) check('F23 공개 키 없음: 준비 안 됨 안내', (await resultText(page)).includes('지금은 신청을 받을 수 없습니다'));
    else check(`F24 ${label}: 준비 중 안내·입력 잠금`, (await page.locator('.form-banner').count()) === 1 && (await page.evaluate(() => document.querySelector('fieldset').disabled)));
    await ctx.close();
  }
}

const recoverBtn = (page) => page.locator('.bot-recover button');
const waitToken = (page, n) => page.waitForFunction((k) => window.__ts && window.__ts.issued >= k, n);

/** PM 6908334832 1항: 만료·오류 → 사용자의 '다시 확인' → SDK reset → SDK가 새 토큰 발급 → 제출(시험이 토큰을 직접 넣지 않음) */
async function scenarioBotRecovery(browser) {
  const { page, ctx, seen } = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', api: reply(202, { ok: true }), tsConf: { auto: true } });
  await waitToken(page, 1);
  await fill(page);
  await page.evaluate(() => window.__ts.opts['expired-callback']());
  await page.click('button[type=submit]');
  check('F25 만료 뒤 제출: 전송 0회, 다시 확인 버튼 표시', seen.api.length === 0 && (await recoverBtn(page).count()) === 1);
  const resets0 = await page.evaluate(() => window.__ts.resets);
  await recoverBtn(page).click();
  await waitToken(page, 2);
  check('F26 다시 확인 → SDK reset 1회 → SDK가 새 토큰 발급, 버튼 사라짐',
    (await page.evaluate(() => window.__ts.resets)) === resets0 + 1 && (await recoverBtn(page).count()) === 0);
  await page.evaluate(() => window.__ts.opts['error-callback']());
  await page.waitForFunction(() => document.querySelector('.bot-recover'));
  await recoverBtn(page).click();
  await waitToken(page, 3);
  await submitAndSettle(page, seen);
  check('F27 오류 → 다시 확인 → 새 토큰으로 접수(전송 토큰 = SDK 최신 발급)',
    seen.api.length === 1 && seen.api[0].turnstileToken === 'auto-tok-3' && (await resultText(page)).includes('접수되었습니다'));
  check('F27b 페이지 예외 0', seen.pageErrors.length === 0, seen.pageErrors.join(','));
  await ctx.close();
}

/** 1항: 초기 스크립트 로딩 실패 → 오류·재시도(실패 태그 정리 후 새로 삽입, 중복 없음) */
async function scenarioScriptFailure(browser) {
  const { page, ctx, seen } = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', api: reply(202, { ok: true }), tsConf: { auto: true }, scriptFailTimes: 1 });
  await page.waitForFunction(() => document.querySelector('.bot-recover'));
  const tags1 = await page.evaluate(() => document.querySelectorAll('script[src*="turnstile"]').length);
  check('F28 초기 스크립트 실패: 무한 로딩 대신 고정 오류·다시 확인, 실패 태그 정리', (await recoverBtn(page).count()) === 1 && tags1 === 0 && seen.turnstile === 1, `tags=${tags1} req=${seen.turnstile}`);
  await recoverBtn(page).click();
  await waitToken(page, 1);
  const tags2 = await page.evaluate(() => document.querySelectorAll('script[src*="turnstile"]').length);
  check('F29 다시 확인 → 스크립트 새로 1개 삽입·로드 → render → 새 토큰', tags2 === 1 && seen.turnstile === 2 && (await page.evaluate(() => window.__ts.renders)) === 1, `tags=${tags2} req=${seen.turnstile}`);
  await fill(page);
  await submitAndSettle(page, seen);
  check('F30 복구 뒤 접수', seen.api.length === 1 && seen.api[0].turnstileToken === 'auto-tok-1');
  await ctx.close();
}

/** 1항: render 예외·ID 미반환 → 오류·재마운트 */
async function scenarioRenderFailure(browser) {
  for (const mode of ['throw', 'undefined']) {
    const { page, ctx, seen } = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', api: reply(202, { ok: true }), tsConf: { auto: true, renderFailTimes: 1, renderFailMode: mode } });
    await page.waitForFunction(() => document.querySelector('.bot-recover'));
    check(`F31 render ${mode}: 고정 오류·다시 확인(무한 로딩 없음), 페이지 예외 0`, (await recoverBtn(page).count()) === 1 && seen.pageErrors.length === 0);
    await recoverBtn(page).click();
    await waitToken(page, 1);
    check(`F32 render ${mode}: 다시 확인 → 재마운트 render 성공 → 새 토큰, 스크립트 1개`,
      (await page.evaluate(() => window.__ts.renderCalls)) === 2 && (await page.evaluate(() => document.querySelectorAll('script[src*="turnstile"]').length)) === 1);
    await ctx.close();
  }
}

/** 2항: SDK reset·remove 예외가 폼을 잠그지 않음 */
async function scenarioSdkThrows(browser) {
  let mode = 'abort';
  const { page, ctx, seen } = await openForm(browser, {
    enabled: true,
    siteKey: 'test-only-site-key',
    tsConf: { auto: true, resetThrows: true, removeThrows: true },
    api: (route) => (mode === 'abort' ? route.abort('failed') : reply(202, { ok: true })(route)),
  });
  await waitToken(page, 1);
  await fill(page);
  await submitAndSettle(page, seen);
  const st = await page.evaluate(() => ({ locked: document.querySelector('fieldset').disabled, busy: document.querySelector('form').getAttribute('aria-busy') }));
  check('F33 reset 예외 + 응답 유실: 잠금 해제·aria-busy 해제·결과 문구·입력 보존·페이지 예외 0',
    !st.locked && st.busy !== 'true' && (await resultText(page)).includes('확인하지 못했습니다') && (await page.inputValue('input[name=phone]')) === '010-0000-0001' && seen.pageErrors.length === 0,
    `${JSON.stringify(st)} err=${seen.pageErrors.join(',')}`);
  // reset 실패 → 재마운트(render 2회째)로 새 토큰. 새 토큰을 받은 뒤에만 다시 보낸다
  await page.waitForFunction(() => window.__ts.renders >= 2 && window.__ts.issued >= 2);
  const beforeRetry = seen.api.length;
  mode = 'ok';
  await submitAndSettle(page, seen);
  check('F34 reset 실패 → 재마운트·새 토큰으로 같은 키 재시도 → 접수, remove 예외에도 페이지 예외 0',
    beforeRetry === 1 && seen.api.length === 2 && seen.api[1].idempotencyKey === seen.api[0].idempotencyKey && seen.api[1].turnstileToken !== seen.api[0].turnstileToken &&
      (await resultText(page)).includes('접수되었습니다') && seen.pageErrors.length === 0, `api=${seen.api.length} err=${seen.pageErrors.join(',')}`);
  await ctx.close();
}

/** 3항: 처리방침 버전·공개 키가 비거나 공백이면 위젯·접수 요청 0 */
async function scenarioNotReady(browser) {
  for (const [label, privacy, siteKey] of [['처리방침 버전 빈 값', '', 'test-only-site-key'], ['처리방침 버전 공백', '   ', 'test-only-site-key'], ['공개 키 공백', 'privacy-test-v1', '   ']]) {
    const { page, ctx, seen } = await openForm(browser, { enabled: true, siteKey, privacy, api: reply(202, { ok: true }), tsConf: { auto: true } });
    await page.waitForTimeout(300);
    await fill(page);
    await page.click('button[type=submit]');
    await page.waitForTimeout(200);
    check(`F35 ${label}: 위젯 외부 요청 0·접수 요청 0·준비 안 됨 안내`,
      seen.turnstile === 0 && seen.api.length === 0 && (await resultText(page)).includes('지금은 신청을 받을 수 없습니다'), `ts=${seen.turnstile} api=${seen.api.length}`);
    await ctx.close();
  }
}

/** development 번들 + StrictMode: effect 정리·재마운트에서 위젯·스크립트 중복 없음(관찰값 그대로 보고) */
async function scenarioDevStrict(browser) {
  const { page, ctx, seen } = await openForm(browser, { enabled: true, siteKey: 'test-only-site-key', dev: true, api: reply(202, { ok: true }), tsConf: { auto: true } });
  await waitToken(page, 1);
  await page.waitForTimeout(200);
  const o = await page.evaluate(() => ({ renderCalls: window.__ts.renderCalls, renders: window.__ts.renders, removes: window.__ts.removes, loads: window.__ts.loads, tags: document.querySelectorAll('script[src*="turnstile"]').length, boxes: document.querySelectorAll('[data-fake-turnstile]').length }));
  const isDev = await page.evaluate(() => typeof document.querySelector('form') !== 'undefined');
  check('F36 development·StrictMode: 스크립트 요청 1·태그 1·SDK 실행 1, 위젯 render 1·표시 1(관찰값 기록)',
    isDev && seen.turnstile === 1 && o.tags === 1 && o.loads === 1 && o.renders === 1 && o.boxes === 1, JSON.stringify({ ...o, scriptRequests: seen.turnstile }));
  await fill(page);
  await submitAndSettle(page, seen);
  check('F37 development·StrictMode: 접수 1회, 페이지 예외 0', seen.api.length === 1 && seen.pageErrors.length === 0, seen.pageErrors.join(','));
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await scenarioMain(browser);
  await scenarioDoubleSubmit(browser);
  await scenarioBotStates(browser);
  await scenarioTimeout(browser);
  await scenarioClosed(browser);
  await scenarioBotRecovery(browser);
  await scenarioScriptFailure(browser);
  await scenarioRenderFailure(browser);
  await scenarioSdkThrows(browser);
  await scenarioNotReady(browser);
  await scenarioDevStrict(browser);
  await scenarioPolicyBlocked(browser);
} catch (e) {
  check('시나리오 실행 중 예외 없음', false, String(e && e.message ? e.message.split('\n')[0] : e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`== 상담 폼 상호작용 검수: pass=${results.length - failed} fail=${failed}`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
