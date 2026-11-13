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

const OUT = process.argv[2] ?? 'test-results/screens';

async function main() {
  const css = await readFile('src/app/globals.css', 'utf8');
  const pages: [string, ReactElement][] = [
    ['01-home', <Home />],
    ['02-internet-tv', <InternetTv />],
    ['03-internet-phone', <InternetPhone />],
    ['04-cctv-security', <Cctv />],
    ['05-consult', await Consult({ searchParams: Promise.resolve({ interest: 'internet_tv' }) })],
    ['06-admin-login', <AdminLogin />],
    ['07-admin-leads', <Admin />],
  ];
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
    report.push(`${name}\t가로 넘침=${overflow}\t금액 표기=${prices}`);
    await page.close();
  }
  await browser.close();
  await writeFile(`${OUT}/checks.txt`, report.join('\n') + '\n');
  console.log(report.join('\n'));
  if (report.some((r) => r.includes('가로 넘침=true') || !r.endsWith('금액 표기=0'))) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
