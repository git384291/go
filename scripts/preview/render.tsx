// Next.js 설치 없이 페이지 컴포넌트를 정적 HTML로 렌더링하고 모바일 화면을 캡처한다(미리보기·검수용).
// 실제 빌드·라우팅 검증은 Next.js 설치 후 `npm run build`로 한다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { chromium } from 'playwright';
import RootLayout from '../../src/app/layout';
import Home from '../../src/app/page';
import InternetTv from '../../src/app/products/internet-tv/page';
import InternetPhone from '../../src/app/products/internet-phone/page';
import Cctv from '../../src/app/products/cctv-security/page';
import Consult from '../../src/app/consult/page';
import Admin from '../../src/app/admin/page';
import AdminLogin from '../../src/app/admin/login/page';

// PHASE 1: 고객 화면에 나오면 안 되는 예약 상품 흔적(관리자 화면은 내부 가상 데이터라 제외)
const FORBIDDEN = ['/products/internet-phone', '/products/cctv-security', '/products/mobile', '집전화', 'CCTV', 'cctv',
  'internet_phone', 'cctv_security', 'internet_only', 'value="other"', '동판'];
const PUBLIC_PAGES = new Set(['01-home', '02-internet-tv', '05-consult']);

/** 예약 상품 상세는 notFound()로 404가 나야 한다(Next.js 15 표식) */
function expect404(label: string, render: () => unknown): string {
  try {
    renderToStaticMarkup(render() as ReactElement);
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? (e as Error).message);
    return `${label}\t404=${digest.includes('404')}`;
  }
  return `${label}\t404=false(렌더링됨)`;
}

const OUT = process.argv[2] ?? 'test-results/screens';

async function main() {
  const css = await readFile('src/app/globals.css', 'utf8');
  const pages: [string, ReactElement][] = [
    ['01-home', <Home />],
    ['02-internet-tv', <InternetTv />],
    ['05-consult', await Consult()],
    ['06-admin-login', <AdminLogin />],
    ['07-admin-leads', <Admin />],
  ];
  const routeChecks = [
    expect404('03-internet-phone', () => <InternetPhone />),
    expect404('04-cctv-security', () => <Cctv />),
  ];
  // 상담 페이지는 주소의 ?interest= 값을 읽지 않는다(실제 주소 주입은 tests/e2e/mobile-real.ts 09번이 서버에서 확인).
  // 브라우저로 내려가는 폼 코드에 예약 상품 이름이 없는지는 tests/unit/catalog.test.ts G10이 확인한다.
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const report: string[] = [];
  for (const [name, el] of pages) {
    const html = '<!doctype html>' + renderToStaticMarkup(<RootLayout>{el}</RootLayout>)
      .replace('<html lang="ko">', '<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head>');
    await writeFile(`${OUT}/${name}.html`, html);
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const prices = await page.evaluate(() => (document.body.innerText.match(/[0-9][0-9,]*\s*원/g) ?? []).length);
    await page.screenshot({ path: `${OUT}/${name}-first-view.png` });
    // 전체 페이지 캡처에서는 하단 고정 버튼이 중간에 겹치지 않도록 문서 끝에 둔다
    await page.addStyleTag({ content: '.sticky-cta{position:static}' });
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    const leaked = PUBLIC_PAGES.has(name) ? FORBIDDEN.filter((f) => html.includes(f)) : [];
    const fixed = name.startsWith('05')
      ? `\t상담 대상 고정=${html.includes('name="interest" value="internet_tv"') && !html.includes('<select name="interest"')}` : '';
    report.push(`${name}\t가로 넘침=${overflow}\t금액 표기=${prices}\t예약 상품 노출=${leaked.length ? leaked.join(',') : '없음'}${fixed}`);
    await page.close();
  }
  await browser.close();
  report.push(...routeChecks);
  await writeFile(`${OUT}/checks.txt`, report.join('\n') + '\n');
  console.log(report.join('\n'));
  const bad = report.filter((r) =>
    r.includes('가로 넘침=true') || /금액 표기=[1-9]/.test(r) || /예약 상품 노출=(?!없음)/.test(r)
    || /(404|고정)=false/.test(r));
  if (bad.length) {
    console.error('PREVIEW FAIL\n' + bad.join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
