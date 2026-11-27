// PM 11/22: AI 상담 → 신청서 누락정보 수집 연결(ConsultAiFlow)을 브라우저에서 검수한다. API는 가짜 응답만(실제 AI·네트워크 없음).
// 확인: 채팅 답변 뒤 빠진 필수 항목만 순서대로 이어 묻기, 받은 항목은 다시 묻지 않음, 민감정보·형식 오류 답은 반영 안 됨, 고객 답이 채팅 서버로 가지 않음.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://flow.test';
const results = [];
const check = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`); };
const entry = `import { createRoot } from 'react-dom/client';
  import { ConsultAiFlow } from './src/components/ConsultAiFlow';
  createRoot(document.getElementById('root')).render(<ConsultAiFlow choice={{ carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' }} options={[{ value: 'internet_tv', label: '인터넷+TV' }]} kakaoUrl={null} />);`;
const bundle = async (confirmed) => (await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'flow-entry.tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
  // confirmed=true: 시험용 확정 고지 fixture로 바꿔 끼운다(실제 상수는 미확정). false: 실제 상수 그대로(미확정)
  plugins: confirmed ? [{ name: 'test-notices', setup(b) {
    b.onResolve({ filter: /content\/requiredNotices$/ }, (a) => (/(ConsultForm|ConsultAiFlow)\.tsx$/.test(a.importer) ? { path: 'test-notices', namespace: 'tn' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'tn' }, () => ({ loader: 'ts', contents: `export const REQUIRED_NOTICES = { version: 'privacy-test-v1', confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: '시험용 문구' }] };
export function noticeReadiness(cfg, v) { return cfg.confirmed && cfg.version === v && v !== '' ? { ready: true } : { ready: false, reason: 'X' }; }` }));
  } }] : [],
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_LEAD_FORM_ENABLED': '"true"', 'process.env.NEXT_PUBLIC_PRIVACY_POLICY_VERSION': '"privacy-test-v1"', 'process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY': '"test-only-site-key"' } })).outputFiles[0].text;
const browser = await chromium.launch();
async function scenario(confirmed) {
  const js = await bundle(confirmed);
  const tag = confirmed ? '[고지 확정 fixture] ' : '[실제 상수: 고지 미확정] ';
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const seen = { external: [], api: [], errors: [], leads: 0 };
  page.on('pageerror', (e) => seen.errors.push(e.message.split('\n')[0]));
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url());
    // 가짜 Turnstile(PM 11/22 F1: 상담창 새 세션은 봇 확인 토큰 필요). 렌더·재발급마다 토큰 자동 발급, 실제 Cloudflare 접속 없음
    if (u.host === 'challenges.cloudflare.com') return route.fulfill({ contentType: 'text/javascript', body: "(function(){var n=0;window.turnstile={render:function(el,o){var f=function(){setTimeout(function(){o.callback('auto-tok-'+(++n));},10);};el.__f=f;f();return 'w'+n;},reset:function(id){setTimeout(function(){},0);var els=document.querySelectorAll('*');for(var i=0;i<els.length;i++){if(els[i].__f){els[i].__f();}}},remove:function(){}};})();" });
    if (u.origin !== ORIGIN) { seen.external.push(u.host); return route.abort('blockedbyclient'); }
    if (u.pathname === '/api/leads') { seen.leads = (seen.leads ?? 0) + 1; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }); }
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/a.js"></script>' });
    if (u.pathname === '/a.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (u.pathname === '/api/consult/chat') { seen.api.push(JSON.parse(req.postData() ?? '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, kind: 'needs_review', text: '담당자가 확인한 뒤 안내드립니다.' }) }); }
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('[aria-label="AI 상담"]');
  const log = page.locator('[role=log] p');
  const ask = async (msg) => { const n = await log.count(); await page.fill('textarea[aria-label="상담 내용"]', msg); await page.click('button:has-text("보내기")'); await page.waitForFunction((k) => document.querySelectorAll('[role=log] p').length >= k + 3, n); return (await log.last().textContent()) ?? ''; };
  const prog = () => page.locator('[data-field=assistant-progress]').textContent();
  const sel = (label) => page.click(`[role=group] button:has-text("${label}")`);
  const txt = async (aria, v) => { await page.fill(`input[aria-label="${aria}"]`, v); await page.click('button:has-text("답하기")'); };

  let r = await ask('요금이 궁금해요');
  check(tag + 'FW1 AI 답변 뒤 신청서 도우미가 빠진 첫 필수 항목(설치주소)을 이어서 묻는다', /신청서 도우미: 설치하실 곳의 주소/.test(r), r.slice(0, 60));
  await txt('설치주소', '900101-1234567');
  check(tag + 'FW2 주민번호 형태 답은 신청서에 반영되지 않고 경고, 같은 항목을 다시 묻는다', /필수 0\/8/.test(await prog()) && /설치하실 곳의 주소/.test(await ask('다음은요?')));
  await txt('설치주소', '서울시 가상구 시험로 12 101동 1203호');
  const steps = [['연락받으실 휴대폰의 통신사', () => sel('KT')], ['이메일 주소', () => txt('이메일', 'a@example.com')], ['지금 쓰고 계신 인터넷', () => sel('SK브로드밴드')], ['빠른 날짜로 할까요', () => sel('빠른 날짜')], ['기존 인터넷 회선이 있나요', () => sel('기존 회선 있음')], ['기존회선 12개월 유지 안내를 확인하셨나요', () => sel('확인했습니다')], ['약정 3년 및 설치비 안내를 확인하셨나요', () => sel('확인했습니다')]];
  const askedOrder = [];
  for (const [q, answer] of steps) {
    r = await ask('네');
    askedOrder.push(r.includes(q) ? q : `불일치:${r.slice(0, 50)}`);
    if (/설치하실 곳의 주소/.test(r)) askedOrder.push('주소 재질문!');
    await answer();
  }
  check(tag + 'FW3 누락 질문 순서: 휴대폰 통신사 → 이메일 → 이전통신사 → 설치희망일/빠른 날짜 → 기존회선 확인 → 12개월 유지 안내 → 약정 3년·설치비 안내, 받은 주소는 다시 묻지 않음', askedOrder.every((x, i) => x === steps[i][0]), askedOrder.join(' / '));
  r = await ask('마지막이에요');
  const wantFinal = confirmed ? /아래 가입 상담 신청에서 접수해 주세요/ : /필수 고지 문구가 확정되기 전이라 접수는 아직 받을 수 없습니다/;
  check(tag + 'FW4 모두 받으면 더 묻지 않는다(필수 8/8). 고지 확정 fixture에서만 접수 안내, 미확정이면 "접수 불가" 안내', wantFinal.test(r) && !(confirmed ? /받을 수 없습니다/ : /접수해 주세요/).test(r) && /필수 8\/8/.test(await prog()), r.slice(0, 70));
  const boxes = await page.locator('.consent-box[aria-label="필수 고지"] input[type=checkbox]').count();
  const gateText = (await page.locator('.consent-box[aria-label="필수 고지"]').textContent()) ?? '';
  const state = (await page.locator('[data-field=intake-state]').textContent()) ?? '';
  if (!confirmed) {
    await page.locator('form button[type=submit]').click({ timeout: 2000, force: true }).catch(() => {});
    await page.waitForTimeout(300);
    check(tag + 'FW8 미확정: 가짜 고지 체크박스·가짜 동의 없음, 차단 안내만, 접수 대기 표시, 제출해도 접수 요청 0건', boxes === 0 && /확정되기 전에는 상담 신청을 받지 않습니다/.test(gateText) && /접수 대기/.test(state) && seen.leads === 0, `boxes=${boxes} leads=${seen.leads}`);
  } else {
    check(tag + 'FW8 확정 fixture: 고지 제목·확인 체크박스가 표시되고 접수 가능 표시', boxes === 1 && gateText.includes('시험 고지') && /접수:/.test(state) && !/접수 대기/.test(state), `boxes=${boxes}`);
  }
  const sent = JSON.stringify(seen.api);
  check(tag + 'FW5 채팅 서버로 가는 요청에는 고객의 신청서 답(주소·이메일 등)이 없다(상품 고정 코드+상담 글만, 새 세션엔 1회용 봇 확인 토큰)', !/시험로|example\.com|ack12m|installAddress|email/.test(sent) && seen.api.every((b) => Object.keys(b).every((k) => ['carrier', 'productId', 'regionCode', 'message', 'session', 'campaign', 'turnstileToken'].includes(k))), sent.slice(0, 120));
  const all = await page.locator('[role=log]').textContent();
  check(tag + 'FW6 대화에서 주민번호·자동이체·사은품계좌를 묻는 질문은 없다(안내 문구에서 묻지 않는다고만 밝힘)', !/(주민번호|자동이체|사은품계좌|계좌).{0,12}(알려|입력해|말씀해)/.test(all) && all.includes('묻지 않습니다'));
  check(tag + 'FW7 외부 요청 0·페이지 오류 0', seen.external.length === 0 && seen.errors.length === 0, `${seen.external.join(',')} ${seen.errors.join(',')}`);
  await ctx.close();
}
try { await scenario(false); await scenario(true); } catch (e) { check('시나리오 실행 중 예외 없음', false, String(e && e.message ? e.message.split('\n')[0] : e)); } finally { await browser.close(); }
const failed = results.filter((x) => !x).length;
console.log(`== AI 상담→신청서 연결 검수: pass=${results.length - failed} fail=${failed}`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
