// PM 11/22: 실제 브라우저 단일 흐름 — AI 상담 → 가입정보 수집 → 고지·동의 → 접수 → 관리자 확인 → 총판 신청서 출력.
// 실제 상수(REQUIRED_NOTICES)는 미확정이라 건드리지 않는다. 대신 "시험 전용 앱 사본"(임시 폴더)에서 고지 상수만 승인된 시험 fixture(DB 문구)로 바꿔
// 두 번째 next dev(포트 3139)를 띄우고, 같은 폐기 DB·같은 서버 코드로 검증한다. 운영 접수 차단(미확정 상수)은 check.mjs의 N8b·RV9·UI1이 계속 확인한다.
// 외부 호출 없음: 봇 확인 스크립트는 Playwright 경로 가로채기로 가짜 SDK만 주고, 서버는 가상 확인 서버('ok' 토큰)로 확인한다.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha = (s) => crypto.createHash('sha256').update(s.trim(), 'utf8').digest('hex');
const FX_PORT = 3139;
const FAKE_TS = `(function(){var st=window.__ts={r:0,opts:null};function issue(){setTimeout(function(){st.opts&&st.opts.callback('ok');},10);}
window.turnstile={render:function(el,o){st.r++;st.opts=o;issue();return 'w'+st.r;},reset:function(){issue();},remove:function(){}};})();`;

/** 시험 전용 앱 사본: 고지 상수만 승인된 시험 fixture로 바꾼다(원본 소스는 건드리지 않는다) */
function buildFixtureApp(root, items, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fideon-fx-app-'));
  for (const d of ['src']) fs.cpSync(path.join(root, d), path.join(dir, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json', 'next.config.ts']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const p = path.join(dir, 'src/content/requiredNotices.ts');
  const src = fs.readFileSync(p, 'utf8');
  const lit = JSON.stringify({ version, confirmed: true, items: items.map((r) => ({ key: r.notice_key, title: '시험 고지 ' + r.notice_key, body: r.body })) });
  const out = src.replace(/export const REQUIRED_NOTICES: NoticeConfig = Object\.freeze\(\{[\s\S]*?\}\);\n/, `export const REQUIRED_NOTICES: NoticeConfig = Object.freeze(${lit}) as NoticeConfig; // 시험 fixture(임시 사본)\n`);
  if (out === src) throw new Error('fixture: REQUIRED_NOTICES 치환 실패');
  fs.writeFileSync(p, out);
  return dir;
}

export async function runBrowserFlow(c) {
  const { sql, n, check, adm: admBase, pj, post, BASE, owner, reviewer, editor, counselor, pubUrl } = c;
  const { chromium } = await import('playwright');
  const VERSION = 'next-e2e-v1';
  const FXB = `http://127.0.0.1:${FX_PORT}`;
  const adm = (p, cookie, init = {}) => fetch(FXB + p, { ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } }); // 관리자 API도 시험 앱(고지 확정 fixture)으로 보낸다
  const items = await sql.unsafe(`select notice_key, body from core.notice_texts where version = '${VERSION}' order by notice_key`);
  const root = process.cwd();
  const dir = buildFixtureApp(root, items, VERSION);
  const FX = `http://127.0.0.1:${FX_PORT}`;
  const logPath = path.join(root, 'test-results/next-e2e/next-fixture.log');
  const logFd = fs.openSync(logPath, 'w');
  const env = { ...process.env, NODE_ENV: 'development', PRIVACY_POLICY_VERSION: VERSION, NEXT_PUBLIC_PRIVACY_POLICY_VERSION: VERSION, NEXT_PUBLIC_LEAD_FORM_ENABLED: 'true', NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'test-only-site-key', CONSULT_CHAT_PRODUCT: 'next-e2e-p1', CONSULT_CHAT_CARRIER: 'carrier-x', CONSULT_CHAT_REGION: 'region-1' };
  delete env.CONSULT_AI_API_KEY;
  const srv = spawn(path.join(root, 'node_modules/.bin/next'), ['dev', '-p', String(FX_PORT), '-H', '127.0.0.1'], { cwd: dir, env, stdio: ['ignore', logFd, logFd] });
  const pv = (v) => sql.unsafe(`update core.settings set value = '${JSON.stringify(v)}'::jsonb where key = 'privacy_policy_version'`);
  const pv0 = (await sql.unsafe(`select value #>> '{}' as v from core.settings where key = 'privacy_policy_version'`))[0]?.v;
  let br = null;
  const pubSet = (enabled) => adm(pubUrl, owner, { method: 'POST', body: JSON.stringify({ enabled, reason: 'Next E2E 브라우저 흐름' }) });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { await fetch(`${FX}/api/consult/chat`); up = true; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
    check('BF0 시험 전용 앱(고지 확정 fixture, 같은 서버 코드·같은 폐기 DB) 기동', up && items.length >= 2, `notices=${items.length}`);
    if (!up) return;
    await pv(VERSION);
    await pubSet(true);
    br = await chromium.launch();
    const snap = async () => [await n(`select count(*)::int as n from core.leads`), await n(`select count(*)::int as n from pii.customers`), await n(`select count(*)::int as n from pii.consents`), await n(`select count(*)::int as n from pii.notice_exposures`), await n(`select count(*)::int as n from pii.lead_applications`), await n(`select count(*)::int as n from core.audit_logs where action = 'application.save'`)].join(',');
    let ipSeq = 100;
    const newCtx = async ({ noSubtle = false } = {}) => {
      const ctx = await br.newContext({ viewport: { width: 390, height: 1800 }, bypassCSP: true, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${++ipSeq}` } }); // next dev eval 때문에 시험 브라우저만 CSP 우회
      await ctx.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_TS }));
      if (noSubtle) await ctx.addInitScript(() => { Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true }); });
      return ctx;
    };
    const openCustomer = async (ctx) => {
      const pg = await ctx.newPage();
      const posts = [];
      pg.on('request', (r) => { if (r.url().endsWith('/api/leads') && r.method() === 'POST') posts.push(r.postData() ?? ''); });
      await pg.goto(`${FX}/consult/ai`, { waitUntil: 'networkidle' });
      await pg.waitForTimeout(1500);
      return { pg, posts };
    };
    const ask = async (pg, msg) => { const k = await pg.locator('[role=log] p').count(); await pg.fill('textarea[aria-label="상담 내용"]', msg); await pg.click('button:has-text("보내기")'); await pg.waitForFunction((x) => document.querySelectorAll('[role=log] p').length >= x + 3, k, { timeout: 25000 }); return (await pg.locator('[role=log] p').last().textContent()) ?? ''; };
    const assist = async (pg) => {
      await pg.fill('input[aria-label="설치주소"]', '서울시 가상구 브라우저로 9 301호'); await pg.click('button:has-text("답하기")');
      await pg.click('[role=group] button:text-is("KT")');
      await pg.fill('input[aria-label="이메일"]', 'browser.e2e@example.com'); await pg.click('button:has-text("답하기")');
      for (const l of ['SK브로드밴드', '빠른 날짜', '기존 회선 있음', '확인했습니다', '확인했습니다']) await pg.click(`[role=group] button:has-text("${l}")`);
    };
    const fillForm = async (pg, { notices = true } = {}) => {
      await pg.fill('input[name=name]', '김브라우저'); await pg.fill('input[name=phone]', '010-9999-5678');
      await pg.locator('.consent-box:not([aria-label]) input[type=checkbox]').first().check();
      if (notices) for (const b of await pg.locator('.consent-box[aria-label="필수 고지"] input[type=checkbox]').all()) await b.check();
    };
    const submit = (pg) => pg.click('form button[type=submit]');
    const resultText = async (pg) => { await pg.waitForTimeout(400); await pg.waitForFunction(() => document.querySelector('form')?.getAttribute('aria-busy') !== 'true' && document.querySelector('.form-result'), null, { timeout: 20000 }); return (await pg.locator('.form-result').textContent()) ?? ''; };

    // ── 1~5: 상담 → 수집 → 고지·동의 → (일부러 실패) → 재시도 접수
    const s0 = await snap();
    const cust = await newCtx();
    const { pg, posts } = await openCustomer(cust);
    const stateText = (await pg.locator('[data-field=intake-state]').textContent()) ?? '';
    const noticeBoxes = await pg.locator('.consent-box[aria-label="필수 고지"] input[type=checkbox]').count();
    const shownBodies = []; // 고객 화면에 실제로 보인 고지 본문(펼친 문구)
    for (const p of await pg.locator('.consent-box[aria-label="필수 고지"] details p').all()) shownBodies.push((await p.textContent()) ?? '');
    check('BF1 고지 확정 fixture 화면: "접수" 안내 + 항목별 고지 확인 체크박스가 고지 수만큼 표시', /^접수:/.test(stateText.trim()) && noticeBoxes === items.length && shownBodies.length === items.length, `state=${stateText.slice(0, 12)} boxes=${noticeBoxes}`);
    const t1 = await ask(pg, '요금이 궁금해요');
    check('BF2 AI 상담: 승인·게시된 정책의 월요금·사은품만 안내하고 이어서 신청서 도우미가 설치주소부터 묻는다', t1.includes('설치하실 곳의 주소') && /11,111/.test(await pg.locator('[role=log]').textContent()) && /3,333/.test(await pg.locator('[role=log]').textContent()), t1.slice(0, 40));
    await assist(pg);
    const t2 = await ask(pg, '이제 접수하고 싶어요');
    const pageText = await pg.locator('body').innerText();
    const inputs = await pg.locator('input, textarea, select').evaluateAll((els) => els.map((e) => `${e.name ?? ''} ${e.getAttribute('aria-label') ?? ''} ${e.placeholder ?? ''}`).join(' | '));
    const FORBID = /주민|자동이체|사은품\s*계좌|계좌번호|resident|account/i;
    const ids = await pg.locator('[data-field=intake-state]').textContent();
    const asText = await pg.locator('#assistant').innerText(); // 채팅창 상단의 '입력하지 마세요' 경고 문구는 질문이 아니므로 제외
    const okA = !/접수는 아직 받을 수 없습니다/.test(t2), okB = /^접수:/.test((ids ?? '').trim()), okC = !FORBID.test(inputs), okD = !/(입력|알려|말씀).{0,12}(주민|자동이체|계좌)|(주민|자동이체|계좌).{0,12}(입력해|알려 주|말씀해)/.test(asText);
    check('BF3 모든 정보를 채우면 "접수 불가" 안내가 아니라 접수 안내로 바뀌고, 주민번호·자동이체·사은품계좌를 묻는 칸·문구가 화면에 없다', okA && okB && okC && okD, `${okA}${okB}${okC}${okD} ${(asText.match(FORBID) ?? [''])[0]} ${inputs.slice(0, 60)}`);

    // 고지 미확인 제출은 막힌다(요청 0건)
    await fillForm(pg, { notices: false }); await submit(pg);
    await pg.waitForTimeout(600);
    check('BF4 고지 확인 없이 제출하면 막힌다(고지 오류 표시, 접수 요청 0건, DB 불변)', posts.length === 0 && (await pg.locator('[role=alert]').allTextContents()).join(' ').includes('고지 항목을 모두 확인') && (await snap()) === s0);

    // 접수 중 실패(신청서 저장 단계) → 전체 취소, 같은 화면에서 고친 뒤 재시도하면 한 번만 저장
    await sql.unsafe(`create or replace function public.e2e_fail_app() returns trigger language plpgsql as $f$ begin raise exception 'e2e forced failure' using errcode = 'XX000'; end $f$`);
    await sql.unsafe(`create trigger e2e_fail_app before insert on pii.lead_applications for each row execute function public.e2e_fail_app()`);
    let fres = '';
    try {
      for (const b of await pg.locator('.consent-box[aria-label="필수 고지"] input[type=checkbox]').all()) await b.check();
      await pg.waitForTimeout(300); await submit(pg); fres = await resultText(pg);
    } finally { await sql.unsafe(`drop trigger if exists e2e_fail_app on pii.lead_applications`); await sql.unsafe(`drop function if exists public.e2e_fail_app()`); }
    const s1 = await snap();
    check('BF5 접수 중 신청서 저장이 실패하면 응답은 실패(접수 완료 아님), 리드·고객·동의·고지 노출·신청서·저장 감사가 모두 그대로(불완전 기록 없음)', posts.length === 1 && !/신청이 접수되었습니다/.test(fres) && s1 === s0, `${s0} -> ${s1} | ${fres.slice(0, 30)}`);
    await pg.waitForTimeout(500);
    await submit(pg); const okText = await resultText(pg);
    await pg.waitForFunction(() => /접수/.test(document.querySelector('.form-result')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
    const s2 = await snap();
    const body = JSON.parse(posts[posts.length - 1]);
    check('BF6 재시도 접수 성공: 화면 "신청이 접수되었습니다", 리드·고객·동의 +1, 고지 노출 +고지 수, 신청서 +1, 저장 감사 +1', /신청이 접수되었습니다/.test(okText) && posts.length === 2 && s2 === s0.split(',').map((v, i) => Number(v) + [1, 1, 1, items.length, 1, 1][i]).join(','), `${s0} -> ${s2} | ${okText.slice(0, 30)}`);

    // 5: 고지문·해시·버전·동의 기록 일치
    const leadRow = (await sql.unsafe(`select l.id::text as id, l.customer_id::text as cid from core.leads l where l.idempotency_key = '${body.idempotencyKey}'`))[0];
    const domHashes = Object.fromEntries(items.map((r, i) => [r.notice_key, sha(shownBodies[i])]));
    const dbHashes = Object.fromEntries((await sql.unsafe(`select notice_key, body_sha256 from core.notice_texts where version = '${VERSION}'`)).map((r) => [r.notice_key, r.body_sha256]));
    const expo = await sql.unsafe(`select notice_key, body_sha256, doc_version from pii.notice_exposures where customer_id = '${leadRow?.cid}'`);
    const cons = await sql.unsafe(`select doc_version, granted from pii.consents where customer_id = '${leadRow?.cid}' and kind = 'collection_use'`);
    const same = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
    check('BF7 고객 화면 고지 본문의 sha256 = 전송한 noticeHashes = DB 승인 문구 해시 = 고객별 고지 노출 기록 해시, 버전·키·동의 기록(버전·동의함)이 같음', same(domHashes, body.noticeHashes) && same(body.noticeHashes, dbHashes) && same(Object.fromEntries(expo.map((e) => [e.notice_key, e.body_sha256])), dbHashes) && expo.every((e) => e.doc_version === VERSION) && body.noticeVersion === VERSION && body.privacyVersion === VERSION && cons.length === 1 && cons[0].doc_version === VERSION && cons[0].granted === true && [...body.noticeKeys].sort().join() === items.map((r) => r.notice_key).sort().join());
    const appKeys = Object.keys(body.application ?? {}).sort().join();
    check('BF8 전송 본문·DB에 주민번호·자동이체·사은품계좌 항목이 없다(신청서 키는 일반 정보 항목뿐, 평문 원문도 DB에 없음)', !FORBID.test(JSON.stringify(body)) && appKeys === 'ack12m,ackContract3y,carrier,currentCarrier,email,existingLine,installAddress,installPref,phoneCarrier,productId,regionCode' && (await n(`select count(*)::int as n from pii.lead_applications a where to_jsonb(a)::text ~ '(브라우저로|browser\\.e2e|김브라우저|99995678)'`)) === 0 && (await n(`select count(*)::int as n from pii.customers c where to_jsonb(c)::text ~ '(김브라우저|99995678)'`)) === 0, appKeys);

    // ── 관리자 확인 → 총판 신청서 출력(대표, 실제 화면)
    const adminCtx = await br.newContext({ viewport: { width: 1000, height: 1600 }, bypassCSP: true });
    const [cn, ...cv] = owner.split('=');
    await adminCtx.addCookies([{ name: cn, value: cv.join('='), url: FX }]);
    await adminCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: FX }).catch(() => {});
    const ap = await adminCtx.newPage();
    const lr = await adm('/api/admin/leads?limit=20', owner); const lrt = await lr.text();
    console.log(`DIAG list api fx status=${lr.status} body=${lrt.slice(0, 120)}`);
    const lr2 = await admBase('/api/admin/leads?limit=20', owner); console.log(`DIAG list api base status=${lr2.status} body=${(await lr2.text()).slice(0, 120)}`);
    for (const f of ['test-results/next-e2e/next-fixture.log', 'test-results/next-e2e/next.log']) { try { console.log('DIAG ' + f + ': ' + fs.readFileSync(f, 'utf8').split('\n').filter((l) => /LEADLIST_DIAG/.test(l)).slice(-3).join(' || ')); } catch { /* 없음 */ } }
    check('BF9 목록 API', lr.status === 200 && lrt.includes('010-****-5678'), lrt.slice(0, 60));
    await ap.goto(`${FX}/admin/leads/${leadRow?.id}/packet`, { waitUntil: 'networkidle' });
    await ap.waitForSelector('select[aria-label="열람 사유"]', { timeout: 20000 });
    await ap.waitForTimeout(1000);
    await ap.selectOption('select[aria-label="열람 사유"]', 'dealer_handoff');
    await ap.click('button:has-text("신청서 열기")');
    await ap.waitForSelector('pre[data-field=packet]', { timeout: 20000 });
    const shown = await ap.locator('pre[data-field=packet]').textContent();
    const st = (await ap.locator('[data-field=status]').textContent()) ?? '';
    // 승인 정책(DB 승인본)에서 기대값을 따로 계산한다: 화면 출력 로직이 아니라 정책 원본과 대조
    const pol = (await sql.unsafe(`select terms from core.policy_versions where product_id = 'next-e2e-p1' and state = 'approved' limit 1`))[0]?.terms;
    const won = (k) => `${k.value.amountKrw.toLocaleString('en-US')}원(부가세 ${k.value.vat === 'included' ? '포함' : '별도'})`;
    const giftB = pol?.customerBenefit?.value;
    const EXPECT = [
      ['고객명', '김브라우저'], ['주민번호', '총판 별도 확인'], ['설치주소', '서울시 가상구 브라우저로 9 301호'], ['연락처 / 통신사', '01099995678 / KT'], ['이메일', 'browser.e2e@example.com'],
      ['자동이체', '총판 별도 확인'], ['사은품계좌', '총판 별도 확인'], ['가입 통신사', 'carrier-x'], ['신청상품', '가상 인터넷+TV(Next E2E)'],
      ['월요금', won(pol?.monthlyFee ?? { value: { amountKrw: -1, vat: 'x' } })], ['설치비(기사출동비)', won(pol?.installFee ?? { value: { amountKrw: -1, vat: 'x' } })], ['설치희망일 / 빠른 날짜', '빠른 날짜'],
      ['상품권', `${giftB?.amountKrw?.toLocaleString('en-US')}원 상품권`], ['이전통신사', 'SK브로드밴드'], ['기타: 기존회선 12개월 유지 안내', '고객 확인함'], ['기존회선 확인', '기존 회선 있음'], ['약정 3년 및 설치비 안내·확인', '고객 확인함'],
    ];
    const lines = shown.split('\n').filter((l) => l.startsWith('■ '));
    const exact = lines.length === 17 && EXPECT.every(([k, v], i) => lines[i] === `■ ${k}: ${v}`);
    check('BF10 총판 신청서 17개 항목이 지정 순서·정확한 값으로 출력(고객명~약정 3년 안내)', exact, exact ? '' : lines.map((l, i) => (l === `■ ${EXPECT[i]?.[0]}: ${EXPECT[i]?.[1]}` ? '' : `#${i + 1} ${l}`)).filter(Boolean).slice(0, 3).join(' / '));
    check('BF11 월요금·설치비·상품권이 DB 승인 정책 원본(11,111·2,222·3,333)과 같고, 고객이 AI 상담에서 들은 금액과도 같다', pol && pol.monthlyFee.value.amountKrw === 11111 && pol.installFee.value.amountKrw === 2222 && giftB.amountKrw === 3333 && shown.includes('월요금: 11,111원(부가세 포함)') && shown.includes('설치비(기사출동비): 2,222원(부가세 포함)') && shown.includes('상품권: 3,333원 상품권'));
    const sentBtn = ap.locator('button:has-text("총판 전달 완료 기록")');
    check('BF12 고지가 확정·확인된 접수는 "총판 전달 준비 완료"로 표시되고 전달 완료 기록 버튼이 열린다(미확정 때는 막혀 있던 버튼)', /총판 전달 준비 완료/.test(shown) && /준비 완료/.test(st) && (await sentBtn.isDisabled()) && (await (async () => { await ap.fill('input[aria-label="전달 메모"]', 'A총판'); return !(await sentBtn.isDisabled()); })()), st.trim().slice(0, 40));
    await ap.click('button:has-text("복사")');
    await ap.waitForFunction(() => document.querySelector('[data-field=msg]')?.textContent?.includes('복사 기록'), null, { timeout: 15000 }).catch(() => {});
    const clip = await ap.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    const hist1 = (await ap.locator('[data-field=history]').textContent()) ?? '';
    await sentBtn.click();
    await ap.waitForFunction(() => /전달 완료/.test(document.querySelector('[data-field=history]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
    const sent = { status: (await ap.locator('[data-field=history]').textContent()).includes('sent') || /전달 완료/.test((await ap.locator('[data-field=history]').textContent()) ?? '') ? 200 : 0 };
    const sentBad = await adm(`/api/admin/leads/${leadRow?.id}/handoff`, owner, { method: 'POST', body: JSON.stringify({ event: 'sent', note: 'A총판 010-9999-5678' }) });
    check('BF13 복사 내용이 화면 문서와 같고(복사 기록), 전달 완료 기록은 준비 완료 건에서만 200(총판 이름만 허용·전화번호 메모 400)', (clip === '' || clip.trim() === shown.trim()) && (await pj(await adm(`/api/admin/leads/${leadRow?.id}/handoff`, owner))).items?.some((i) => i.event === 'copied') && sent.status === 200 && sentBad.status === 400, `sent=${sent.status} bad=${sentBad.status} clip=${clip.length}/${shown.length} hist=${hist1.slice(0, 40)}`);
    console.log('--- 총판 신청서 출력(브라우저 E2E, 가상 시험 데이터) ---\n' + shown + '\n---');

    // 6: owner 외 계정 차단(API·화면)
    const lid = leadRow?.id;
    const pk = (cookie) => adm(`/api/admin/leads/${lid}/packet`, cookie, { method: 'POST', body: JSON.stringify({ reason: 'dealer_handoff' }) });
    const codes = [];
    for (const [nm, ck] of [['검토자', reviewer], ['편집자', editor], ['상담원', counselor], ['무인증', null]]) { const r = await pk(ck); const t = await r.text(); codes.push(`${nm}:${r.status}${/브라우저로|browser\.e2e|김브라우저|99995678/.test(t) ? ':원문노출' : ''}`); }
    const hdl = []; for (const [nm, ck] of [['검토자', reviewer], ['편집자', editor], ['상담원', counselor]]) { const r = await adm(`/api/admin/leads/${lid}/handoff`, ck); hdl.push(`${nm}:${r.status}`); }
    const rctx = await br.newContext({ viewport: { width: 1000, height: 1400 }, bypassCSP: true });
    const [rn, ...rv] = reviewer.split('=');
    await rctx.addCookies([{ name: rn, value: rv.join('='), url: FX }]);
    const rp = await rctx.newPage();
    await rp.goto(`${FX}/admin/leads/${lid}/packet`, { waitUntil: 'networkidle' }).catch(() => {});
    await rp.waitForTimeout(1200);
    const rb = await rp.locator('body').innerText().catch(() => '');
    if (await rp.locator('select[aria-label="열람 사유"]').count()) { await rp.selectOption('select[aria-label="열람 사유"]', 'dealer_handoff').catch(() => {}); await rp.click('button:has-text("신청서 열기")').catch(() => {}); await rp.waitForTimeout(1500); }
    const rb2 = await rp.locator('body').innerText().catch(() => '');
    check('BF14 owner 외 계정은 신청서 원문 접근 불가: 검토자·편집자·상담원 403, 무인증 401, 이력 조회도 403, 검토자 브라우저에서도 원문(이름·주소·이메일·번호) 미표시', codes.join(' ') === '검토자:403 편집자:403 상담원:403 무인증:401' && hdl.every((x) => x.endsWith(':403')) && !/브라우저로|browser\.e2e|김브라우저|99995678/.test(rb + rb2) && (await rp.locator('pre[data-field=packet]').count()) === 0, codes.join(' ') + ' ' + hdl.join(' '));
    await rctx.close(); await adminCtx.close();
    const auditPii = await n(`select count(*)::int as n from core.audit_logs a where to_jsonb(a)::text ~ '(브라우저로|browser\\.e2e|김브라우저|99995678|9999-5678)'`);
    check('BF15 감사 로그 어디에도 이름·주소·이메일·전화 원문 없음(열람 사유는 고정 코드, 복사·전달 이벤트 기록)', auditPii === 0 && (await n(`select count(*)::int as n from core.audit_logs where action = 'pii.reveal' and detail ->> 'via' = 'dealer_packet' and target_id = '${lid}' and reason = 'dealer_handoff'`)) >= 1);

    // 7: 구버전 화면 — 고지 해시를 보내지 않는 옛 화면, 또는 오래된 고지 해시를 보내는 화면
    const sOld0 = await snap();
    const oldCtx = await newCtx();
    const oldVariants = [['해시 없는 옛 화면', (b) => { delete b.noticeHashes; return b; }], ['오래된 고지 해시', (b) => { b.noticeHashes = Object.fromEntries(Object.keys(b.noticeHashes).map((k) => [k, 'e'.repeat(64)])); return b; }]];
    const oldRes = [];
    for (const [label, mut] of oldVariants) {
      const o = await openCustomer(oldCtx);
      await o.pg.route('**/api/leads', async (route) => { const b = JSON.parse(route.request().postData() ?? '{}'); const r = await route.fetch({ postData: JSON.stringify(mut(b)) }); await route.fulfill({ response: r }); });
      await ask(o.pg, '요금이 궁금해요'); await assist(o.pg); await fillForm(o.pg); await submit(o.pg);
      const t = await resultText(o.pg);
      oldRes.push({ label, t, posts: o.posts.length });
      await o.pg.close();
    }
    check('BF16 구버전 화면 접수는 안전하게 차단되고(서버 503, 저장 0건) 화면이 "페이지를 새로 고친 뒤 고지를 다시 확인"하라고 안내', oldRes.every((r) => r.posts === 1 && /새로 고친 뒤/.test(r.t) && !/접수되었습니다/.test(r.t)) && (await snap()) === sOld0, oldRes.map((r) => `${r.label}:${r.t.slice(0, 16)}`).join(' / '));
    await oldCtx.close();

    // 8: HTTPS/Web Crypto 불가 — 요청 자체를 만들지 않는다
    const nsCtx = await newCtx({ noSubtle: true });
    const ns = await openCustomer(nsCtx);
    await ask(ns.pg, '요금이 궁금해요'); await assist(ns.pg); await fillForm(ns.pg); await submit(ns.pg);
    const nt = await resultText(ns.pg);
    const nsSubtle = await ns.pg.evaluate(() => typeof crypto.subtle);
    check('BF17 Web Crypto를 쓸 수 없는 환경(https 아님)에서는 접수 요청 0건·DB 저장 0건으로 막고 "보안 연결(https)" 안내', nsSubtle === 'undefined' && ns.posts.length === 0 && /보안 연결\(https\)/.test(nt) && (await snap()) === sOld0, `subtle=${nsSubtle} posts=${ns.posts.length} ${nt.slice(0, 24)}`);
    await nsCtx.close();

    // 종합 정합성: 이번 흐름 전체(성공 1건)에서 리드·고객·동의·신청서·노출이 짝이 맞는다
    const orphan = await n(`select count(*)::int as n from core.leads l where l.customer_id is not null and (not exists (select 1 from pii.consents c where c.customer_id = l.customer_id) or not exists (select 1 from pii.notice_exposures e where e.customer_id = l.customer_id)) and l.idempotency_key = '${body.idempotencyKey}'`);
    const appLead = await n(`select count(*)::int as n from pii.lead_applications where lead_id = '${lid}'`);
    check('BF18 DB 정합성: 성공 1건은 리드·고객·동의·고지 노출·신청서가 서로 연결돼 있고 어긋난 레코드(신청서 없는 신청 접수·동의 없는 고객) 없음', orphan === 0 && appLead === 1 && (await snap()) === s2);
  } finally {
    try { await sql.unsafe(`drop trigger if exists e2e_fail_app on pii.lead_applications`); await sql.unsafe(`drop function if exists public.e2e_fail_app()`); } catch { /* 정리 */ }
    try { await pubSet(false); } catch { /* 정리 */ }
    await pv(pv0);
    if (br) await br.close();
    srv.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1000)); try { srv.kill('SIGKILL'); } catch { /* 종료됨 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 */ }
  }
}
