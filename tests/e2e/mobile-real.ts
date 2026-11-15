// REV-006 3-8: 실행 중인 실제 Next.js 서버에 실제 브라우저(Chromium, WebKit)로 접속해 모바일 화면을 검사한다.
// 사용: npx tsx tests/e2e/mobile-real.ts http://127.0.0.1:3100 <출력 폴더>
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, devices, type Browser } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const OUT = process.argv[3] ?? 'test-results/e2e';

// [이름, 주소, 기대 HTTP 상태] — PHASE 1: 예약 상품 상세는 404
const PAGES = [
  ['01-home', '/', 200],
  ['02-internet-tv', '/products/internet-tv', 200],
  ['03-internet-phone', '/products/internet-phone', 404],
  ['04-cctv-security', '/products/cctv-security', 404],
  ['05-consult', '/consult?interest=internet_tv', 200],
  ['06-privacy', '/privacy', 200],
  ['07-admin-login', '/admin/login', 200],
  ['08-admin-leads', '/admin', 200],
  ['09-consult-injected', '/consult?interest=cctv_security', 200],
  ['10-mobile', '/products/mobile', 404],
] as const;

// 고객 화면에 나오면 안 되는 예약 상품 흔적(관리자 화면 제외)
const FORBIDDEN = ['/products/internet-phone', '/products/cctv-security', '/products/mobile', '집전화', 'CCTV', 'cctv_security', 'internet_phone', '동판'];
// PHASE 1 보완: 외부 상담 채널(카카오톡) 연결은 모든 화면(관리자 제외)에서 없어야 한다. 화면 글자와 링크 주소로 확인
const EXTERNAL_TEXT = ['카카오'];
const EXTERNAL_HREF = /kakao/i;
// Mac 검증 보완 ⑧: 접수가 꺼진 동안 접수 가능으로 오해할 문구 금지, 준비 중 안내 필수(고객 화면)
const INTAKE_PHRASES = ['무료 상담 신청', '연락처만 남겨', '이 상품으로 상담 신청', '상담 신청하기', '남기면 됩니다', '연락드려'];
const NOTICE = '온라인 상담 서비스 준비 중';
const NOTICE_PAGES = new Set(['01-home', '02-internet-tv', '05-consult', '09-consult-injected']);

const DEVICES = [
  ['iphone13', webkit, devices['iPhone 13']],
  ['galaxy-s9', chromium, devices['Galaxy S9+']],
] as const;

type Row = { device: string; page: string; status: number; expected: number; overflow: boolean; prices: number; consoleErrors: number; leaked: string[] };

async function checkApis(): Promise<string[]> {
  const fails: string[] = [];
  // 진단 경로는 로컬 서버에서 열리지 않아야 한다
  const diag = await fetch(`${BASE}/api/diag/ip`);
  if (diag.status !== 404) fails.push(`/api/diag/ip status=${diag.status} (expected 404)`);
  // 상담 신청 API — 상태 코드·응답 본문을 정확히 검증한다(가짜 값만 사용).
  // 이 E2E 서버는 실제 수집을 끈 상태(LEAD_INTAKE_MODE 미설정)로 실행된다. API는 '수집 차단' 검사를 가장 먼저 하므로
  // 모든 신청은 상품과 관계없이 503 LEAD_INTAKE_DISABLED로 거부되어야 한다(이 값이 바뀌면 수집이 열린 것).
  // 예약 상품의 403 PRODUCT_NOT_ACTIVE는 수집 차단을 통과해야만 나오는 응답이므로,
  // 수집을 켜지 않고 같은 API 경로 함수를 직접 호출하는 tests/route/leads-route.test.ts가 정확히 검증한다.
  const EXPECT_DISABLED = { status: 503, body: { ok: false, code: 'LEAD_INTAKE_DISABLED' } };
  const leadCases: [string, unknown][] = [
    ['internet_tv', { name: '테스트', phone: '01000000000', interest: 'internet_tv', consentCollection: true }],
    ...(['internet_phone', 'cctv_security', 'internet_only', 'other', 'mobile'] as const).map(
      (interest): [string, unknown] => [interest, { name: '테스트', phone: '01000000000', interest, consentCollection: true }],
    ),
    // 변형 값·누락도 같은 응답이어야 한다(상품 값으로 우회 불가)
    ['CCTV_SECURITY', { name: '테스트', phone: '01000000000', interest: 'CCTV_SECURITY' }],
    ['interest 배열', { name: '테스트', phone: '01000000000', interest: ['internet_tv', 'cctv_security'] }],
    ['interest 없음', { name: '테스트', phone: '01000000000' }],
  ];
  for (const [label, payload] of leadCases) {
    const r = await fetch(`${BASE}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const type = r.headers.get('content-type') ?? '';
    const text = await r.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = `(JSON 아님) ${text.slice(0, 80)}`;
    }
    if (r.status !== EXPECT_DISABLED.status || !type.includes('application/json')
        || JSON.stringify(body) !== JSON.stringify(EXPECT_DISABLED.body)) {
      fails.push(`/api/leads [${label}] HTTP ${r.status} ${JSON.stringify(body)} (기대: HTTP 503 ${JSON.stringify(EXPECT_DISABLED.body)})`);
    }
  }
  return fails;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const rows: Row[] = [];
  for (const [devName, engine, desc] of DEVICES) {
    let browser: Browser;
    try {
      browser = await engine.launch();
    } catch (e) {
      console.error(`${devName}: 브라우저 실행 실패 (npx playwright install ${engine.name()})`, e);
      process.exitCode = 1;
      continue;
    }
    const ctx = await browser.newContext({ ...desc });
    for (const [name, path, expected] of PAGES) {
      const page = await ctx.newPage();
      let consoleErrors = 0;
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors++; });
      page.on('pageerror', () => consoleErrors++);
      const res = await page.goto(BASE + path, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      const prices = await page.evaluate(() => (document.body.innerText.match(/[0-9][0-9,]*\s*원/g) ?? []).length);
      await page.screenshot({ path: `${OUT}/${devName}-${name}.png`, fullPage: true });
      const html = await page.content();
      const leaked = name.includes('admin') || expected === 404 ? [] : FORBIDDEN.filter((f) => html.includes(f));
      if (!name.includes('admin') && expected !== 404) {
        const text = await page.evaluate(() => document.body.innerText);
        const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? ''));
        leaked.push(...EXTERNAL_TEXT.filter((t) => text.includes(t)), ...hrefs.filter((h) => EXTERNAL_HREF.test(h)));
        leaked.push(...INTAKE_PHRASES.filter((t) => text.includes(t)));
        if (NOTICE_PAGES.has(name) && !text.includes(NOTICE)) leaked.push('준비 중 안내 없음');
      }
      // 404 화면은 Next.js가 내부적으로 콘솔 오류를 남길 수 있어 오류 수를 세지 않는다
      rows.push({ device: devName, page: name, status: res?.status() ?? 0, expected, overflow, prices,
                  consoleErrors: expected === 404 ? 0 : consoleErrors, leaked });
      await page.close();
    }
    await browser.close();
  }
  const apiFails = await checkApis();
  const lines = rows.map((r) => `${r.device}\t${r.page}\tHTTP=${r.status}(기대 ${r.expected})\t가로 넘침=${r.overflow}\t금액 표기=${r.prices}\t콘솔 오류=${r.consoleErrors}\t예약 상품 노출=${r.leaked.length ? r.leaked.join(',') : '없음'}`);
  lines.push(...apiFails.map((f) => `API FAIL\t${f}`));
  await writeFile(`${OUT}/checks.txt`, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  const bad = rows.filter((r) => r.status !== r.expected || r.overflow || r.prices > 0 || r.consoleErrors > 0 || r.leaked.length > 0);
  if (bad.length || apiFails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
