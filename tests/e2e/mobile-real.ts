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
  // 실제 수집이 꺼진 상태에서 상담 신청은 저장되지 않아야 한다(가짜 값만 사용)
  const lead = await fetch(`${BASE}/api/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '테스트', phone: '01000000000', interest: 'internet_tv', consents: {} }),
  });
  if (lead.status < 400) fails.push(`/api/leads status=${lead.status} (expected 4xx/503 while intake disabled)`);
  // PHASE 1: 예약 상품으로 직접 호출해도 저장되지 않아야 한다
  for (const interest of ['internet_phone', 'cctv_security', 'internet_only', 'other', 'mobile']) {
    const r = await fetch(`${BASE}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '테스트', phone: '01000000000', interest }),
    });
    if (r.status < 400) fails.push(`/api/leads interest=${interest} status=${r.status} (expected 4xx/503)`);
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
