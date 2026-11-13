// REV-006 3-8: 실행 중인 실제 Next.js 서버에 실제 브라우저(Chromium, WebKit)로 접속해 모바일 화면을 검사한다.
// 사용: npx tsx tests/e2e/mobile-real.ts http://127.0.0.1:3100 <출력 폴더>
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, devices, type Browser } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const OUT = process.argv[3] ?? 'test-results/e2e';

const PAGES = [
  ['01-home', '/'],
  ['02-internet-tv', '/products/internet-tv'],
  ['03-internet-phone', '/products/internet-phone'],
  ['04-cctv-security', '/products/cctv-security'],
  ['05-consult', '/consult?interest=internet_tv'],
  ['06-privacy', '/privacy'],
  ['07-admin-login', '/admin/login'],
  ['08-admin-leads', '/admin'],
] as const;

const DEVICES = [
  ['iphone13', webkit, devices['iPhone 13']],
  ['galaxy-s9', chromium, devices['Galaxy S9+']],
] as const;

type Row = { device: string; page: string; status: number; overflow: boolean; prices: number; consoleErrors: number };

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
    for (const [name, path] of PAGES) {
      const page = await ctx.newPage();
      let consoleErrors = 0;
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors++; });
      page.on('pageerror', () => consoleErrors++);
      const res = await page.goto(BASE + path, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      const prices = await page.evaluate(() => (document.body.innerText.match(/[0-9][0-9,]*\s*원/g) ?? []).length);
      await page.screenshot({ path: `${OUT}/${devName}-${name}.png`, fullPage: true });
      rows.push({ device: devName, page: name, status: res?.status() ?? 0, overflow, prices, consoleErrors });
      await page.close();
    }
    await browser.close();
  }
  const apiFails = await checkApis();
  const lines = rows.map((r) => `${r.device}\t${r.page}\tHTTP=${r.status}\t가로 넘침=${r.overflow}\t금액 표기=${r.prices}\t콘솔 오류=${r.consoleErrors}`);
  lines.push(...apiFails.map((f) => `API FAIL\t${f}`));
  await writeFile(`${OUT}/checks.txt`, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  const bad = rows.filter((r) => r.status !== 200 || r.overflow || r.prices > 0 || r.consoleErrors > 0);
  if (bad.length || apiFails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
