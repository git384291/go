// PM 7011892065: 모바일 웹 상담 비공개 시안(가상 대화)을 실제 브라우저에서 조작해 검수한다.
// - Next.js 없이 컴포넌트만 esbuild로 묶어 가상 주소(http://consult.test)에 띄운다. 서버·포트·DB 없음.
// - 가상 주소 밖으로 나가는 요청은 모두 막고 개수를 센다(기대값 0). 저장소(localStorage 등)·쿠키 사용도 점검한다.
// - 시각은 Playwright 가짜 시계로 고정해 평일·토요일·일요일 경계를 시험한다(실제 시계·타이머 경로 그대로 사용).
// - 결과 화면 캡처와 증거는 test-results/consult-preview/ 에 쓴다(저장소에는 넣지 않는 경로).
// 실행: node scripts/preview/consult-preview.mjs [--html-out /절대/경로/consult-preview.html]
//   --html-out: 사용자 전달용 단일 HTML 파일(오프라인에서 열 수 있음)을 저장소 밖 경로에 쓴다.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://consult.test';
const OUT = path.join(ROOT, 'test-results', 'consult-preview');
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`);
}

const entry = `
  import { StrictMode } from 'react';
  import { createRoot } from 'react-dom/client';
  import { ConsultPreviewChat } from './src/components/ConsultPreviewChat';
  createRoot(document.getElementById('root')).render(<StrictMode><ConsultPreviewChat /></StrictMode>);`;

const built = await build({
  stdin: { contents: entry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'consult-entry.tsx' },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
const js = built.outputFiles[0].text;
const css = readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>상담 시안(비공개)</title><style>${css}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;

const outArg = process.argv.indexOf('--html-out');
if (outArg > 0) {
  const target = process.argv[outArg + 1];
  if (!target || !path.isAbsolute(target) || !path.relative(ROOT, target).startsWith('..')) {
    console.error('거부: --html-out은 저장소 밖 절대 경로여야 합니다');
    process.exit(2);
  }
  writeFileSync(target, html);
  console.log(`단일 HTML 저장: ${path.basename(target)} (${html.length} bytes)`);
}

const browser = await chromium.launch();

/** 한 시나리오용 새 페이지. 가상 주소 밖 요청은 막고 센다 */
async function openPage(width, nowIso) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'America/New_York' });
  const page = await context.newPage();
  const external = [];
  const requests = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url === `${ORIGIN}/`) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    external.push(url);
    return route.abort();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (nowIso) await page.clock.install({ time: new Date(nowIso) });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('.cp-wrap');
  return { page, context, external, requests, errors };
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.body.scrollWidth <= document.documentElement.clientWidth);
const choiceLabels = (page) => page.$$eval('.cp-choices button', (els) => els.map((e) => e.textContent.trim()));
const summaryText = (page) => page.$eval('.cp-summary', (e) => e.textContent).catch(() => null);
const click = (page, text) => page.locator('.cp-choice', { hasText: text }).first().click();
const NOW_THU = '2026-11-19T11:00:00+09:00';

for (const width of [320, 390]) {
  const tag = `${width}px`;
  const { page, context, external, errors } = await openPage(width, NOW_THU);

  // 1) 첫 화면
  check(`[${tag}] 첫 화면에 가정용 / 매장·사무실용 두 선택만`, JSON.stringify((await choiceLabels(page)).map((t) => t.split('\n')[0].replace(/(가정용|매장·사무실용).*/, '$1'))) === JSON.stringify(['가정용', '매장·사무실용']), (await choiceLabels(page)).join(' | '));
  const body = await page.locator('body').innerText();
  check(`[${tag}] AI 도우미 표시와 가상 대화 표시`, body.includes('AI 도우미가 안내하는 화면이에요') && body.includes('가상 대화 시안'));
  check(`[${tag}] 글자 입력칸 0 (input·textarea·select·편집 가능 영역)`, (await page.locator('input, textarea, select, [contenteditable]').count()) === 0);
  check(`[${tag}] 링크(a[href])·tel 0`, (await page.locator('a[href]').count()) === 0);
  check(`[${tag}] 평일에는 전화 안내 숨김`, (await page.locator('.cp-phone').count()) === 0);
  check(`[${tag}] 가로 넘침 없음(첫 화면)`, await noOverflow(page));
  await page.screenshot({ path: path.join(OUT, `01-first-${width}.png`), fullPage: true });

  // 2) 가정용: 한 번에 질문 하나
  await click(page, '가정용');
  check(`[${tag}] 가정용 첫 질문만 보임(선택지 2개)`, (await choiceLabels(page)).length === 2 && (await page.locator('.cp-turn[data-step]').count()) === 1);
  await click(page, '이사해서 새로 알아봐요');
  check(`[${tag}] 이사 선택 후 자연스러운 답과 다음 질문 하나`, (await page.locator('body').innerText()).includes('금액이나 일정을 확정해 드릴 수 없어요') && (await page.locator('.cp-turn[data-step="devices"]').count()) === 1);
  await click(page, '5개 이상');
  await click(page, '매일 봐요');
  const s1 = await summaryText(page);
  check(`[${tag}] 마지막에 요약 3부분(선택 조건·확인된 일반 안내·확인할 항목)`, s1 && ['선택 조건', '확인된 일반 안내', '확인할 항목'].every((h) => s1.includes(h)));
  check(`[${tag}] 요약에 선택한 조건이 들어감`, s1 && s1.includes('이사해서 새로 알아봐요') && s1.includes('5개 이상') && s1.includes('매일 봐요'));
  check(`[${tag}] 요약이 견적·접수가 아니라고 밝힘`, s1 && s1.includes('견적이나 접수가 아니에요'));
  check(`[${tag}] 가로 넘침 없음(가정용 요약)`, await noOverflow(page));
  await page.screenshot({ path: path.join(OUT, `02-home-summary-${width}.png`), fullPage: true });

  // 3) 이전 선택 수정 → 요약 갱신
  await page.locator('.cp-turn', { hasText: '지금 어떤 이유로 알아보세요?' }).locator('.cp-edit').click();
  check(`[${tag}] 이전 선택을 고치면 요약이 사라지고 그 질문부터 다시 묻는다`, (await summaryText(page)) === null && (await choiceLabels(page)).some((t) => t.includes('쓰던 약정이 끝나서')));
  await click(page, '쓰던 약정이 끝나서 비교해요');
  await click(page, '3~4개');
  await click(page, '거의 안 봐요');
  const s2 = await summaryText(page);
  check(`[${tag}] 고친 뒤 요약이 새 선택으로 갱신(이전 선택·뒤 선택 잔재 없음)`, s2 && s2.includes('쓰던 약정이 끝나서 비교해요') && s2.includes('3~4개') && s2.includes('거의 안 봐요') && !s2.includes('이사해서 새로 알아봐요') && !s2.includes('5개 이상') && !s2.includes('매일 봐요'));
  check(`[${tag}] 확인할 항목이 선택에 맞게 바뀜(약정 해지 비용)`, s2 && s2.includes('해지 비용') && !s1.includes('해지 비용'));

  // 4) 용도 자체를 고치기 → 처음 화면, 사업장 흐름
  await page.locator('.cp-answer-row').first().locator('.cp-edit').click();
  check(`[${tag}] 용도를 고치면 처음 두 선택으로 돌아가고 요약이 없다`, (await choiceLabels(page)).length === 2 && (await summaryText(page)) === null);
  await click(page, '매장·사무실용');
  await click(page, '카드 결제·배달 주문이 멈추는 거예요');
  check(`[${tag}] 사업장 둘째 질문(TV 용도)만 보임`, (await page.locator('.cp-turn[data-step="tvuse"]').count()) === 1);
  await click(page, '손님이 보는 홀·객실에 둬요');
  const s3 = await summaryText(page);
  check(`[${tag}] 사업장 요약(결제·객실 TV)`, s3 && s3.includes('매장·사무실용') && s3.includes('카드 결제') && s3.includes('손님이 보는') && s3.includes('해당 장소에서 이용 가능한 상품인지'));
  check(`[${tag}] 가로 넘침 없음(사업장 요약)`, await noOverflow(page));
  await page.screenshot({ path: path.join(OUT, `03-business-summary-${width}.png`), fullPage: true });

  // 5) FAQ·개인정보 FAQ·승인된 예시
  const all = await page.locator('body').innerText();
  check(`[${tag}] 승인된 두 상담 예시 문구 표시`, all.includes('지금은 금액이나 일정을 확정해 드릴 수 없어요.') && all.includes('현재 담당자 연결을 확인할 수 없어요.'));
  const priv = await page.locator('section[aria-label="개인정보 안내"]').evaluate((e) => e.textContent);
  check(`[${tag}] 개인정보 FAQ: 지금 입력할 정보 없음, 다음 단계 처리 주체·보관 기간·동의 방법 안내`, priv.includes('아무것도 입력하지 않아요') && priv.includes('처리하는 곳') && priv.includes('보관 기간') && priv.includes('동의 방법'));
  check(`[${tag}] 정정 전 문구 없음('자리에 없어요')`, !all.includes('자리에 없'));
  check(`[${tag}] 성공 표시 문구 없음(접수 완료·전달 완료·가입 완료 등)`, !/(접수|가입|예약|신청|연결)\s*(됐|되었|완료|성공)|전달\s*(됐|완료)/.test(all.replace('이 문의가 전달됐다고 말씀드릴 수는 없어요', '')));

  // 6) 외부 전송·저장 0
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, url: location.href }));
  check(`[${tag}] 저장소·쿠키 사용 0`, storage.local === 0 && storage.session === 0 && storage.cookie === '');
  check(`[${tag}] 외부 요청 시도 0, 화면 이동 없음`, external.length === 0 && storage.url === `${ORIGIN}/`, `외부 ${external.length}건`);
  check(`[${tag}] 브라우저 오류 0`, errors.length === 0, errors.join(' / '));
  await context.close();
}

// 7) 평일·주말·시간 경계(한국 시간): 가짜 시계 + 컴포넌트의 실제 시계 경로
const buttonState = async (iso, width = 390) => {
  const { page, context, external, errors } = await openPage(width, iso);
  const section = await page.locator('.cp-phone').count();
  const btn = await page.getByRole('button', { name: '모의 전화 버튼' }).count();
  const text = section ? await page.locator('.cp-phone').innerText() : '';
  return { page, context, section, btn, text, external, errors };
};
const cases = [
  ['금요일 12:00', '2026-11-20T12:00:00+09:00', { section: 0, btn: 0 }],
  ['토요일 00:00', '2026-11-21T00:00:00+09:00', { section: 1, btn: 0 }],
  ['토요일 09:59', '2026-11-21T09:59:00+09:00', { section: 1, btn: 0 }],
  ['토요일 10:00', '2026-11-21T10:00:00+09:00', { section: 1, btn: 1 }],
  ['토요일 15:59', '2026-11-21T15:59:00+09:00', { section: 1, btn: 1 }],
  ['토요일 16:00', '2026-11-21T16:00:00+09:00', { section: 1, btn: 0 }],
  ['일요일 12:00', '2026-11-22T12:00:00+09:00', { section: 1, btn: 0 }],
  ['월요일 00:00', '2026-11-23T00:00:00+09:00', { section: 0, btn: 0 }],
];
for (const [label, iso, want] of cases) {
  const r = await buttonState(iso);
  check(`[시각] ${label}: 전화 안내 ${want.section ? '있음' : '숨김'}, 모의 전화 버튼 ${want.btn ? '있음' : '없음'}`, r.section === want.section && r.btn === want.btn, r.text.replace(/\s+/g, ' ').slice(0, 80));
  if (label === '일요일 12:00') check('[시각] 일요일은 토요일 운영 안내만', r.text.includes('토요일 10:00~16:00') && r.text.includes('가상 시간'));
  if (label === '토요일 10:00') {
    await r.page.screenshot({ path: path.join(OUT, '04-saturday-open-390.png'), fullPage: true });
    await r.page.getByRole('button', { name: '모의 전화 버튼' }).click();
    const t = await r.page.locator('.cp-mock-result').innerText();
    check('[시각] 모의 전화 버튼은 안내만 표시(실제 전화·전달 아님)', t.includes('실제로 전화가 걸리거나 담당자에게 전달되지 않아요') && r.page.url() === `${ORIGIN}/`);
    check('[시각] 모의 전화 뒤에도 외부 요청 0', r.external.length === 0);
  }
  check(`[시각] ${label}: 브라우저 오류·외부 요청 0`, r.errors.length === 0 && r.external.length === 0);
  await r.context.close();
}

// 8) 열린 채로 16:00을 넘기면 버튼이 사라진다(실제 30초 타이머 경로)
{
  const { page, context } = await openPage(320, '2026-11-21T15:59:40+09:00');
  const before = await page.getByRole('button', { name: '모의 전화 버튼' }).count();
  await page.clock.fastForward('00:40');
  await page.waitForTimeout(100);
  const after = await page.getByRole('button', { name: '모의 전화 버튼' }).count();
  check('[시각] 토요일 15:59:40에 열어 둔 화면이 16:00을 지나면 모의 전화 버튼이 사라진다', before === 1 && after === 0, `전 ${before} / 후 ${after}`);
  check('[320px] 토요일 안내 화면 가로 넘침 없음', await noOverflow(page));
  await context.close();
}

// 9) 컴퓨터 시간대(뉴욕)가 달라도 한국 시간으로 판단: 위 시나리오가 timezoneId=America/New_York 에서 통과했다
check('[시각] 브라우저 시간대가 한국이 아니어도(뉴욕) 한국 시간으로 판단', results.filter((r) => r.name.startsWith('[시각] 토요일 10:00')).every((r) => r.pass));

await browser.close();
const failed = results.filter((r) => !r.pass);
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (failed.length > 0) {
  console.error(`실패 ${failed.length}건: ${failed.map((f) => f.name).join(' ; ')}`);
  process.exit(1);
}
