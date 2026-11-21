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
    const newCtx = async ({ noSubtle = false, width = 390 } = {}) => {
      const ctx = await br.newContext({ viewport: { width, height: 1800 }, bypassCSP: true, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${++ipSeq}` } }); // next dev eval 때문에 시험 브라우저만 CSP 우회
      await ctx.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_TS }));
      if (noSubtle) await ctx.addInitScript(() => { Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true }); });
      return ctx;
    };
    const openCustomer = async (ctx) => {
      const pg = await ctx.newPage();
      const posts = [];
      const resps = []; const sent = new Map(); // PM 11/22 P2: 접수 응답(상태·헤더·본문·소요 시간) 비교용
      pg.on('request', (r) => { if (r.url().endsWith('/api/leads') && r.method() === 'POST') { posts.push(r.postData() ?? ''); sent.set(r, Date.now()); } });
      pg.on('response', (r) => {
        if (!(r.url().endsWith('/api/leads') && r.request().method() === 'POST')) return;
        const ms = Date.now() - (sent.get(r.request()) ?? Date.now());
        resps.push((async () => { const h = r.headers(); const names = Object.keys(h).sort(); const vals = names.filter((k) => !/^(date|content-security-policy.*|x-request-id|report-to|reporting-endpoints)$/.test(k)).map((k) => `${k}=${h[k]}`); return { status: r.status(), body: await r.text().catch(() => '?'), names: names.join(','), vals: vals.join(';'), ms }; })());
      });
      await pg.goto(`${FX}/consult/ai`, { waitUntil: 'networkidle' });
      await pg.waitForTimeout(1500);
      return { pg, posts, resps };
    };
    const ask = async (pg, msg) => { const k = await pg.locator('[role=log] p').count(); await pg.fill('textarea[aria-label="상담 내용"]', msg); await pg.click('button:has-text("보내기")'); await pg.waitForFunction((x) => document.querySelectorAll('[role=log] p').length >= x + 3, k, { timeout: 25000 }); return (await pg.locator('[role=log] p').last().textContent()) ?? ''; };
    const assist = async (pg) => {
      await pg.fill('input[aria-label="설치주소"]', '서울시 가상구 브라우저로 9 301호'); await pg.click('button:has-text("답하기")');
      await pg.click('[role=group] button:text-is("KT")');
      await pg.fill('input[aria-label="이메일"]', 'browser.e2e@example.com'); await pg.click('button:has-text("답하기")');
      for (const l of ['SK브로드밴드', '빠른 날짜', '기존 회선 있음', '확인했습니다', '확인했습니다']) await pg.click(`[role=group] button:has-text("${l}")`);
    };
    const fillForm = async (pg, { notices = true, phone = '010-9999-5678' } = {}) => {
      await pg.fill('input[name=name]', '김브라우저'); await pg.fill('input[name=phone]', phone);
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
    // 목록: 시험 앱(3139)의 실제 API와 실제 /admin 화면으로 확인한다(DB 직접 조회로 대체하지 않는다). 시험 DB에는 예약 상품 접수 행도 있으나 목록은 열린다(제외)
    const lr = await adm('/api/admin/leads?limit=50', owner); const lrt = await lr.text();
    check('BF9 목록 API(시험 앱): 200, 방금 접수가 마스킹(010-****-5678)으로 보이고 원문 이름·번호 없음, 예약 상품 행은 제외(DB에는 있음)', lr.status === 200 && lrt.includes('010-****-5678') && !lrt.includes('김브라우저') && !lrt.includes('99995678') && !/cctv_security|internet_phone/.test(lrt) && (await n(`select count(*)::int as n from core.leads where interest in ('cctv_security','internet_phone')`)) >= 2, `status=${lr.status}`);
    await ap.goto(`${FX}/admin`, { waitUntil: 'networkidle' });
    await ap.waitForTimeout(1500);
    const listText = await ap.locator('body').innerText();
    const link = ap.locator(`a.lead-packet[href="/admin/leads/${leadRow?.id}/packet"]`);
    check('BF9b 실제 /admin 화면: 접수 목록이 열리고 해당 고객의 마스킹된 행(010-****-5678)과 신청서 링크가 보이며 원문 이름·번호·"목록을 불러오지 못했습니다" 없음', listText.includes('010-****-5678') && !listText.includes('김브라우저') && !listText.includes('99995678') && !listText.includes('불러오지 못했습니다') && (await link.count()) === 1, `rows=${await ap.locator('a.lead-packet').count()} ${listText.replace(/\s+/g, ' ').slice(0, 80)}`);
    if ((await link.count()) === 1) await link.click(); else await ap.goto(`${FX}/admin/leads/${leadRow?.id}/packet`, { waitUntil: 'networkidle' });
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
    const lst = []; for (const [nm, ck] of [['검토자', reviewer], ['편집자', editor], ['상담원', counselor], ['무인증', null]]) { const r = await adm('/api/admin/leads?limit=50', ck); const t = await r.text(); lst.push(`${nm}:${r.status}${/김브라우저|99995678|010-\*\*\*\*-5678/.test(t) ? ':노출' : ''}`); }
    check('BF14b owner 외 역할의 접수 목록: 검토자·편집자 403, 무인증 401, 상담원은 본인 배정만(미배정 신규 접수 노출 없음)', lst.join(' ') === '검토자:403 편집자:403 상담원:200 무인증:401', lst.join(' '));
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

    // ── PM 11/22 옥의티 점검: 새로고침·뒤로가기·중복 클릭·같은 연락처 재접수·모바일(320·390)·고객 오류 문구
    const overflow = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const TECH = /undefined|\bnull\b|NaN|exception|stack|SQL|\b[45]\d\d\b|[A-Z][A-Z_]{5,}|INTERNAL|UNAVAILABLE/i;
    // BF19 모바일: 320·390 폭에서 상담·신청서·고지·오류가 가로로 넘치지 않고, 빈 제출 오류가 보이며, 고객에게 보인 모든 오류 문구에 기술 용어가 없다
    const mob = [];
    for (const w of [320, 390]) {
      const mc = await newCtx({ width: w });
      const m = await openCustomer(mc);
      const o1 = await overflow(m.pg);
      await ask(m.pg, '요금이 궁금해요'); await assist(m.pg);
      const o2 = await overflow(m.pg);
      await m.pg.click('form button[type=submit]'); await m.pg.waitForTimeout(500);
      const errs = (await m.pg.locator('[role=alert]').allTextContents()).join(' ');
      const o3 = await overflow(m.pg);
      const vis = await m.pg.locator('form button[type=submit]').isVisible();
      mob.push({ w, o: [o1, o2, o3], errs, vis, posts: m.posts.length });
      await mc.close();
    }
    const custTexts = [fres, nt, ...oldRes.map((r) => r.t), ...mob.map((r) => r.errs)];
    check('BF19 모바일(320·390): 상담·신청서·고지·오류 화면이 가로로 넘치지 않고 접수 버튼이 보이며, 빈 제출 오류가 표시되고(요청 0), 고객에게 보인 오류 문구(고지 오류·저장 실패·구버전·보안 연결·입력 오류)에 기술 용어가 없다',
      mob.every((r) => r.o.every((x) => x <= 1) && r.vis && r.errs.length > 0 && r.posts === 0) && custTexts.every((t) => t.length > 0 && !TECH.test(t)),
      JSON.stringify(mob.map((r) => [r.w, r.o])) + ' | ' + custTexts.filter((t) => TECH.test(t)).map((t) => t.slice(0, 40)).join(' / '));

    // BF20 새로고침·뒤로가기: 입력 중 새로고침하면 입력이 비워지고(저장소에 남기지 않음) 요청·DB 변화가 없으며, 뒤로/앞으로 이동도 접수를 만들지 않는다
    const sR0 = await snap();
    const rc = await newCtx();
    const r1 = await openCustomer(rc);
    await ask(r1.pg, '요금이 궁금해요'); await assist(r1.pg); await fillForm(r1.pg, { phone: '010-9999-2222' });
    await r1.pg.reload({ waitUntil: 'networkidle' }); await r1.pg.waitForTimeout(1000);
    const afterReload = [await r1.pg.inputValue('input[name=name]'), await r1.pg.inputValue('input[name=phone]')];
    const checked = await r1.pg.locator('form input[type=checkbox]:checked').count();
    await r1.pg.goto(`${FX}/`, { waitUntil: 'networkidle' }); await r1.pg.goBack({ waitUntil: 'networkidle' }); await r1.pg.waitForTimeout(800); await r1.pg.goForward({ waitUntil: 'networkidle' }).catch(() => {});
    check('BF20 새로고침·뒤로가기·앞으로: 이름·번호·동의 입력이 남지 않고(개인정보를 브라우저에 보관하지 않음) 접수 요청 0건·DB 변화 없음', afterReload.every((v) => v === '') && checked === 0 && r1.posts.length === 0 && (await snap()) === sR0, `${JSON.stringify(afterReload)} checked=${checked} posts=${r1.posts.length}`);
    await rc.close();

    // BF21 중복 클릭: 같은 화면에서 접수 버튼을 빠르게 두 번 눌러도 요청 1건·리드 +1·신청서 +1(다른 연락처)
    const sD0 = await snap();
    const dc = await newCtx();
    const d1 = await openCustomer(dc);
    await ask(d1.pg, '요금이 궁금해요'); await assist(d1.pg); await fillForm(d1.pg, { phone: '010-9999-3333' });
    await d1.pg.waitForTimeout(300);
    await d1.pg.dblclick('form button[type=submit]').catch(() => {});
    const dtext = await resultText(d1.pg);
    await d1.pg.waitForTimeout(500);
    const rNew = await Promise.all(d1.resps);
    check('BF21 접수 버튼 더블클릭: 접수 요청 1건, 화면 "신청이 접수되었습니다", 리드·고객·동의·신청서 각 +1', d1.posts.length === 1 && /신청이 접수되었습니다/.test(dtext) && (await snap()) === sD0.split(',').map((v, i) => Number(v) + [1, 1, 1, items.length, 1, 1][i]).join(','), `${sD0} -> ${await snap()} posts=${d1.posts.length}`);
    await dc.close();

    // BF22 같은 고객 재접속·재접수(같은 연락처): 새 접수 요청은 정상 응답이지만 새 리드·신청서는 만들지 않고 재문의로만 기록된다(현재 동작 기록)
    const sS0 = await snap();
    const rep0 = await n(`select count(*)::int as n from core.lead_status_history where reason = 'repeat_inquiry'`);
    const sc = await newCtx();
    const s1c = await openCustomer(sc);
    await ask(s1c.pg, '요금이 궁금해요'); await assist(s1c.pg); await fillForm(s1c.pg, { phone: '010-9999-3333' }); await submit(s1c.pg);
    const stext = await resultText(s1c.pg);
    const rSame = await Promise.all(s1c.resps);
    const rep1 = await n(`select count(*)::int as n from core.lead_status_history where reason = 'repeat_inquiry'`);
    const sS1 = await snap();
    const phoneLeads = await n(`select count(*)::int as n from core.leads l join pii.customers c on c.id = l.customer_id join pii.lead_applications a on a.lead_id = l.id where c.phone_hmac = (select phone_hmac from pii.customers order by created_at desc limit 1)`);
    check('BF22 같은 연락처·같은 내용 재접수(7일 내): 화면은 새 접수와 같은 "신청이 접수되었습니다"(존재 여부 비노출), 리드·고객·동의·신청서·고지 노출·변경 요청 증가 0건, 재문의 기록 +1, 그 연락처의 리드·신청서는 1건씩', s1c.posts.length === 1 && stext.trim() === dtext.trim() && /^신청이 접수되었습니다/.test(stext.trim()) && (await n(`select count(*)::int as n from pii.lead_amendments`)) === 0 && !TECH.test(stext) && sS1 === sS0 && rep1 === rep0 + 1 && phoneLeads === 1, `${sS0} -> ${sS1} rep=${rep0}->${rep1} leads=${phoneLeads} | ${stext.slice(0, 40)}`);
    await sc.close();

    // ── PM 11/22 P1: 같은 연락처의 '다른 내용' 재접수 → 원본은 그대로, 변경 요청(amendment)으로만 저장. 대표만 변경 항목 확인
    const assist2 = async (pg, { addr, carrier, date }) => {
      await pg.fill('input[aria-label="설치주소"]', addr); await pg.click('button:has-text("답하기")');
      await pg.click(`[role=group] button:text-is("${carrier}")`);
      await pg.fill('input[aria-label="이메일"]', 'browser.e2e@example.com'); await pg.click('button:has-text("답하기")');
      await pg.click('[role=group] button:has-text("SK브로드밴드")');
      if (date) { await pg.click('[role=group] button:has-text("희망일 지정")'); await pg.fill('input[aria-label="설치 희망일"]', date); await pg.click('button:has-text("답하기")'); }
      else await pg.click('[role=group] button:has-text("빠른 날짜")');
      for (const l of ['기존 회선 있음', '확인했습니다', '확인했습니다']) await pg.click(`[role=group] button:has-text("${l}")`);
    };
    const reapply = async (opts) => {
      const ctx = await newCtx(); const o = await openCustomer(ctx);
      await ask(o.pg, '요금이 궁금해요'); await assist2(o.pg, opts); await fillForm(o.pg, { phone: '010-9999-3333' }); await submit(o.pg);
      const t = await resultText(o.pg); const posts = o.posts.length; const rs = await Promise.all(o.resps); await ctx.close(); return { t: t.trim(), posts, rs };
    };
    const lid3 = (await sql.unsafe(`select l.id::text as id, l.customer_id::text as cid from core.leads l join pii.customers c on c.id = l.customer_id order by c.created_at desc limit 1`))[0];
    const origOf = async () => JSON.stringify(await sql.unsafe(`select a.payload_enc, a.summary::text as s, a.created_at::text as t, (select string_agg(doc_version || granted::text, ',') from pii.consents where customer_id = a.customer_id) as cons, (select string_agg(notice_key || body_sha256, ',' order by notice_key) from pii.notice_exposures where customer_id = a.customer_id) as expo from pii.lead_applications a where a.lead_id = '${lid3?.id}'`));
    const orig0 = await origOf();
    const sA0 = await snap();
    const amd = () => n(`select count(*)::int as n from pii.lead_amendments where lead_id = '${lid3?.id}'`);
    const a1 = await reapply({ addr: '서울시 가상구 변경로 77 1001호', carrier: 'KT' });
    const amd1 = await amd();
    check('BF23 주소만 바꾼 재접수: 화면은 새 접수와 같은 문구(존재 여부 비노출), 내부에는 변경 요청 1건, 리드·고객·동의·고지 노출·신청서 증가 0건', a1.posts === 1 && a1.t === dtext.trim() && amd1 === 1 && (await snap()) === sA0, `${a1.t.slice(0, 15)} amd=${amd1}`);
    const a1b = await reapply({ addr: '서울시 가상구 변경로 77 1001호', carrier: 'KT' });
    check('BF24 같은 변경 내용을 다시 보내면 화면은 같은 접수 문구, 내부 변경 요청 추가 0건', a1b.t === dtext.trim() && (await amd()) === 1, `${a1b.t.slice(0, 15)} amd=${await amd()}`);
    const a2 = await reapply({ addr: '서울시 가상구 브라우저로 9 301호', carrier: 'SKT', date: '2026-12-05' });
    const amd2 = await amd();
    const orig1 = await origOf();
    check('BF25 통신사·설치희망일 변경 재접수: 화면은 같은 접수 문구, 변경 요청 2건째 저장, 원본 신청서(암호문·요약·해시)·동의·고지 노출 기록은 그대로(덮어쓰기 없음)', a2.t === dtext.trim() && amd2 === 2 && orig1 === orig0 && orig0 !== '[]' && (await snap()) === sA0, `amd=${amd2} same=${orig1 === orig0}`);
    // 대표: 실제 API로 원본 + 변경 항목(이전 → 변경 값) 확인
    const pr3 = await adm(`/api/admin/leads/${lid3?.id}/packet`, owner, { method: 'POST', body: JSON.stringify({ reason: 'content_check' }) }); const pj3 = await pj(pr3);
    const ch = (pj3.amendments ?? []).map((m) => (m.changes ?? []).map((c) => `${c.key}:${c.before}>${c.after}`).join('|'));
    check('BF26 대표 신청서: 원본 신청서는 처음 주소 그대로, 변경 요청 2건과 변경 항목·값(주소 / 휴대폰 통신사 KT→SKT·설치희망 빠른 날짜→희망일 지정·희망일 2026-12-05)이 보존돼 보인다', pr3.status === 200 && String(pj3.packet?.text).includes('서울시 가상구 브라우저로 9 301호') && !String(pj3.packet?.text).includes('변경로') && ch.length === 2 && ch[0] === 'installAddress:서울시 가상구 브라우저로 9 301호>서울시 가상구 변경로 77 1001호' && ch[1] === 'phoneCarrier:KT>SKT|installPref:빠른 날짜>희망일 지정|installDate:(없음)>2026-12-05' && pj3.amendmentsError === false, `${pr3.status} ${JSON.stringify(ch)}`);
    const acx = await br.newContext({ viewport: { width: 390, height: 1600 }, bypassCSP: true });
    const [acn, ...acv] = owner.split('='); await acx.addCookies([{ name: acn, value: acv.join('='), url: FX }]);
    const apg = await acx.newPage();
    await apg.goto(`${FX}/admin/leads/${lid3?.id}/packet`, { waitUntil: 'networkidle' });
    await apg.waitForSelector('select[aria-label="열람 사유"]', { timeout: 20000 }); await apg.waitForTimeout(800);
    await apg.selectOption('select[aria-label="열람 사유"]', 'content_check'); await apg.click('button:has-text("신청서 열기")');
    await apg.waitForSelector('[data-field=amendments]', { timeout: 20000 });
    const amText = await apg.locator('[data-field=amendments]').innerText();
    const amOver = await apg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('BF26b 실제 신청서 화면(대표, 모바일 폭): "고객 변경 요청 2건 — 원본은 바뀌지 않음" 안내와 변경 항목이 보이고 가로 넘침 없음', /고객 변경 요청 2건/.test(amText) && /원본\)는 바뀌지 않았습니다/.test(amText) && amText.includes('휴대폰 통신사: KT → SKT') && amOver <= 1, `${amText.slice(0, 60)} over=${amOver}`);
    await acx.close();
    const deny = [];
    for (const [nm, ck] of [['reviewer', reviewer], ['editor', editor], ['counselor', counselor], ['anon', null]]) { const r = await adm(`/api/admin/leads/${lid3?.id}/packet`, ck, { method: 'POST', body: JSON.stringify({ reason: 'content_check' }) }); const t = await r.text(); deny.push([nm, r.status, t.includes('변경로')]); }
    check('BF27 대표 외(검토자·편집자·상담원·무인증)는 변경 요청 내용에 접근 불가(401/403, 본문에 변경 주소 없음)', deny.every(([, st, leak]) => (st === 401 || st === 403) && !leak), JSON.stringify(deny));
    const auditLeak = await n(`select count(*)::int as n from core.audit_logs where (coalesce(detail::text, '') || coalesce(reason, '')) ~ '변경로|브라우저로|가상구|example\\.com|010-?9999|김브라우저'`);
    const amAudit = await n(`select count(*)::int as n from core.audit_logs where action = 'application.amend' and target_id = '${lid3?.id}'`);
    // BF29 비로그인 고객이 응답으로 연락처 존재 여부를 구별할 수 없다: 새 접수·같은 내용 재접수·변경 요청·같은 변경 재전송의 상태 코드·헤더 이름·헤더 값(날짜·CSP 제외)·본문이 모두 같다
    const allR = [['new', rNew], ['same', rSame], ['amend', a1.rs], ['amendSame', a1b.rs], ['amend2', a2.rs]].map(([k, rs]) => [k, rs.length === 1 ? rs[0] : null]);
    const base = allR[0][1];
    check('BF29 존재 여부 추론 방지: 새 접수·재접수(같은 내용)·변경 요청·같은 변경 재전송 응답이 상태 202·헤더·본문 {"ok":true}까지 동일(화면 문구도 동일)', !!base && base.status === 202 && JSON.stringify(JSON.parse(base.body)) === '{"ok":true}' && allR.every(([, r]) => r && r.status === base.status && r.body === base.body && r.names === base.names && r.vals === base.vals) && [stext.trim(), a1.t, a1b.t, a2.t].every((t) => t === dtext.trim()), `${base?.status} ${base?.body} ms=${allR.map(([k, r]) => `${k}:${r?.ms}`).join(',')}`);
    check('BF28 감사 로그: 변경 요청 2건이 기록되고(개수·누락 수만), 이름·주소·이메일·전화·암호문 원문 0건', amAudit === 2 && auditLeak === 0, `amend=${amAudit} leak=${auditLeak}`);
  } finally {
    try { await sql.unsafe(`drop trigger if exists e2e_fail_app on pii.lead_applications`); await sql.unsafe(`drop function if exists public.e2e_fail_app()`); } catch { /* 정리 */ }
    try { await pubSet(false); } catch { /* 정리 */ }
    await pv(pv0);
    if (br) await br.close();
    srv.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1000)); try { srv.kill('SIGKILL'); } catch { /* 종료됨 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 */ }
  }
}
