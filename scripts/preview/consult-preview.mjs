// PM 7011892065·7014853871·7014881513: 모바일 웹 상담 비공개 시안(가상 대화)을 실제 브라우저에서 조작해 검수한다.
// - Next.js 없이 컴포넌트만 esbuild로 묶어 가상 주소(http://consult.test)에 띄운다. 서버·포트·DB 없음.
//   (실제 Next 서버 경로 확인은 scripts/server-smoke/run.mjs 가 맡는다.)
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
const HEIGHT = 800;

/** 한 시나리오용 새 페이지. 가상 주소 밖 요청은 막고 센다 */
async function openPage(width, nowIso, ctxOpts = {}) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'America/New_York', ...ctxOpts });
  const page = await context.newPage();
  const external = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
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
  return { page, context, external, errors };
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.body.scrollWidth <= document.documentElement.clientWidth);
const summaryText = (page) => page.$eval('.cp-summary', (e) => e.textContent).catch(() => null);
const summaryFirstLine = (page) => page.$eval('.cp-summary', (e) => e.firstElementChild?.textContent ?? '').catch(() => null);
const currentChoices = (page) => page.$$eval('.cp-current .cp-choice', (els) => els.map((e) => e.textContent.trim()));
const click = (page, text) => page.locator('.cp-choice', { hasText: text }).first().click();
const active = (page) => page.evaluate(() => ({ cls: document.activeElement?.className ?? '', tag: document.activeElement?.tagName ?? '', text: (document.activeElement?.textContent ?? '').trim().slice(0, 60) }));
const NOW_THU = '2026-11-19T11:00:00+09:00';

/** 현재 질문 제목과 선택지 전부가 화면(뷰포트) 안에 있는지 */
async function currentFullyVisible(page) {
  const q = await page.locator('.cp-current .cp-question').boundingBox();
  const boxes = await page.locator('.cp-current .cp-choice').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  if (!q || boxes.length === 0) return false;
  return q.y >= -2 && boxes.every((b) => b.top >= 0 && b.bottom <= HEIGHT);
}
/** 선택 버튼 사이 간격(px)과 높이 */
async function spacing(page, selector) {
  return page.$$eval(selector, (els) => {
    const rects = els.map((e) => e.getBoundingClientRect());
    const gaps = rects.slice(1).map((r, i) => r.top - rects[i].bottom);
    return { minGap: gaps.length ? Math.min(...gaps) : 99, minH: Math.min(...rects.map((r) => r.height)), minW: Math.min(...rects.map((r) => r.width)) };
  });
}
/** 키보드: 초점이 지금 질문 제목에 있을 때, 선택지 label을 Tab으로 찾아 Enter */
async function keyChoose(page, label) {
  const labels = await currentChoices(page);
  const idx = labels.findIndex((t) => t.includes(label));
  if (idx < 0) throw new Error(`선택지 없음: ${label}`);
  for (let i = 0; i <= idx; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
}

for (const width of [320, 390]) {
  const tag = `${width}px`;

  // ── A. 포인터로 가정용 끝까지 ──
  {
    const { page, context, external, errors } = await openPage(width, NOW_THU);
    const h1 = await page.locator('h1.cp-hero-q').innerText();
    check(`[${tag}] 첫 화면 중심은 질문 "집에서 쓰실 건가요, 매장이나 사무실에서 쓰실 건가요?"`, h1 === '집에서 쓰실 건가요, 매장이나 사무실에서 쓰실 건가요?', h1);
    const first = await page.$$eval('.cp-start .cp-choice', (els) => els.map((e) => e.textContent.trim()));
    check(`[${tag}] 첫 화면 선택은 가정용 / 매장·사무실용 두 개`, first.length === 2 && first[0].startsWith('가정용') && first[1].startsWith('매장·사무실용'), first.join(' | '));
    const firstBox = await page.$$eval('.cp-start .cp-choice', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    check(`[${tag}] 첫 화면 한 화면 안에 질문과 두 선택이 모두 보임`, firstBox.every((b) => b.top >= 0 && b.bottom <= HEIGHT), JSON.stringify(firstBox.map((b) => Math.round(b.bottom))));
    const body0 = await page.locator('body').innerText();
    check(`[${tag}] AI 도우미·가상 대화 표시`, body0.includes('AI 도우미가 안내하는 화면이에요') && body0.includes('가상 대화 시안'));
    check(`[${tag}] 글자 입력칸 0·링크 0·전화 안내 숨김(평일)`, (await page.locator('input, textarea, select, [contenteditable]').count()) === 0 && (await page.locator('a[href]').count()) === 0 && (await page.locator('.cp-phone').count()) === 0);
    check(`[${tag}] 보조 영역(예시·FAQ·개인정보)은 접힌 상태`, (await page.$$eval('details[data-aux]', (els) => els.map((e) => e.open))).every((o) => o === false) && (await page.locator('details[data-aux] details[open]').count()) === 0);
    const sp0 = await spacing(page, '.cp-start .cp-choice');
    check(`[${tag}] 첫 화면 선택 버튼 간격 ≥8px, 높이 ≥44px`, sp0.minGap >= 8 && sp0.minH >= 44, `간격 ${sp0.minGap}, 높이 ${Math.round(sp0.minH)}`);
    check(`[${tag}] 가로 넘침 없음(첫 화면)`, await noOverflow(page));
    await page.screenshot({ path: path.join(OUT, `01-first-${width}.png`), fullPage: false });

    await click(page, '가정용');
    check(`[${tag}] 가정용 선택 후 첫 질문과 선택지가 바로 보임`, (await page.locator('.cp-current[data-step="reason"]').count()) === 1 && (await currentFullyVisible(page)));
    await click(page, '이사해서 새로 알아봐요');
    check(`[${tag}] 이사 선택 후 AI 안내가 현재 질문 바로 위에 있고 다음 질문 하나만 보임`, (await page.locator('.cp-current[data-reply], .cp-current [data-reply]').count()) === 1 && (await page.locator('.cp-current[data-step="devices"]').count()) === 1 && (await currentFullyVisible(page)));
    await click(page, '3~4개');
    check(`[${tag}] 선택이 쌓여도(2개 답) 현재 질문·선택지가 화면에 바로 보임`, (await page.locator('.cp-current[data-step="tv"]').count()) === 1 && (await currentFullyVisible(page)));
    const hist = await page.locator('details.cp-history').evaluate((e) => e.open);
    check(`[${tag}] 이전 답은 접혀 있음`, hist === false);
    const sp1 = await spacing(page, '.cp-current .cp-choice');
    check(`[${tag}] 질문 선택 버튼 간격 ≥8px, 높이 ≥44px`, sp1.minGap >= 8 && sp1.minH >= 44, `간격 ${sp1.minGap}, 높이 ${Math.round(sp1.minH)}`);
    await page.screenshot({ path: path.join(OUT, `02-home-midflow-${width}.png`), fullPage: false });
    await click(page, '매일 봐요');
    const s1 = await summaryText(page);
    check(`[${tag}] 요약 첫 줄이 "가장 먼저 비교할 점"(동시 사용과 셋톱박스 임대료)과 이유`, (await summaryFirstLine(page))?.includes('가장 먼저 비교할 점') && (await summaryFirstLine(page))?.includes('동시 사용과 셋톱박스 임대료') && (await summaryFirstLine(page))?.includes('월 부담에 영향을 줘요'));
    check(`[${tag}] 요약 3부분 + 비용 구분`, s1 && ['선택 조건', '비용 구분', '확인된 일반 안내', '확인할 항목'].every((h) => s1.includes(h)));
    const costs = await page.$eval('.cp-costs', (e) => e.textContent);
    check(`[${tag}] 매달 낼 비용(월 요금·장비 임대료)과 설치 관련 비용(금액·청구 시점 확인 필요) 구분, 숫자 없음`, costs.includes('매달 낼 비용') && costs.includes('월 요금') && costs.includes('장비 임대료') && costs.includes('설치 관련 비용') && costs.includes('설치비 금액과 청구 시점은 확인이 필요해요') && !costs.includes('처음 낼 비용') && (costs.match(/확인된 금액 없음/g) ?? []).length === 2 && !/\d/.test(costs), costs.replace(/\s+/g, ' '));
    check(`[${tag}] 요약이 견적·접수가 아니라고 밝힘`, s1.includes('견적이나 접수가 아니에요'));
    check(`[${tag}] 가로 넘침 없음(가정용 요약)`, await noOverflow(page));
    await page.screenshot({ path: path.join(OUT, `03-home-summary-${width}.png`), fullPage: true });

    // 이전 답 펼쳐서 고치기(포인터)
    await page.locator('details.cp-history > summary').click();
    check(`[${tag}] 이전 답 펼치면 답 4개(용도+질문 3개)와 고치기 버튼`, (await page.locator('.cp-history .cp-edit').count()) === 4);
    const spEdit = await spacing(page, '.cp-history .cp-edit');
    check(`[${tag}] 고치기 버튼 높이·너비 ≥44px`, spEdit.minH >= 44 && spEdit.minW >= 44, `높이 ${Math.round(spEdit.minH)}, 너비 ${Math.round(spEdit.minW)}`);
    await page.screenshot({ path: path.join(OUT, `04-history-open-${width}.png`), fullPage: true });
    await page.locator('.cp-history-list li', { hasText: '어떤 이유로' }).locator('.cp-edit').click();
    check(`[${tag}] 이전 답 고치면 낡은 요약 제거·그 질문부터 다시·이전 답 접힘`, (await summaryText(page)) === null && (await page.locator('.cp-current[data-step="reason"]').count()) === 1 && (await page.locator('details.cp-history').evaluate((e) => e.open)) === false);
    check(`[${tag}] 고친 질문으로 초점 이동`, (await active(page)).cls.includes('cp-question'), JSON.stringify(await active(page)));
    await click(page, '쓰던 약정이 끝나서 비교해요');
    await click(page, '3~4개');
    await click(page, '거의 안 봐요');
    const s2 = await summaryText(page);
    check(`[${tag}] 고친 뒤 요약 갱신(이전 선택 잔재 0, 핵심 포인트 교체)`, s2.includes('쓰던 약정이 끝나서 비교해요') && !s2.includes('이사해서 새로 알아봐요') && !s2.includes('매일 봐요') && s2.includes('해지 비용') && !(await summaryFirstLine(page)).includes('셋톱박스 임대료'), (await summaryFirstLine(page)).replace(/\s+/g, ' ').slice(0, 70));

    // 정리 점검
    const all = await page.locator('body').innerText();
    check(`[${tag}] 정정 전 문구·성공 표시 문구 없음`, !all.includes('자리에 없') && !/(접수|가입|예약|신청|연결)\s*(됐|되었|완료|성공)|전달\s*(됐|완료)/.test(all.replace('이 문의가 전달됐다고 말씀드릴 수는 없어요', '')));
    const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, url: location.href }));
    check(`[${tag}] 저장소·쿠키 0, 외부 요청 0, 화면 이동 없음`, storage.local === 0 && storage.session === 0 && storage.cookie === '' && external.length === 0 && storage.url === `${ORIGIN}/`, `외부 ${external.length}건`);
    check(`[${tag}] 브라우저 오류 0`, errors.length === 0, errors.join(' / '));
    await context.close();
  }

  // ── B. 키보드만으로 "아직 잘 모르겠어요" → 요약 → 이전 답 수정 ──
  {
    const { page, context, external, errors } = await openPage(width, NOW_THU);
    await page.keyboard.press('Tab'); // 첫 선택(가정용)
    check(`[${tag}] [키보드] 첫 Tab이 첫 선택(가정용)에 닿음`, (await active(page)).text.startsWith('가정용'), JSON.stringify(await active(page)));
    await page.keyboard.press('Enter');
    check(`[${tag}] [키보드] 용도를 고르면 초점이 다음 질문 제목으로 이동`, (await active(page)).cls.includes('cp-question'), JSON.stringify(await active(page)));
    await keyChoose(page, '이사해서');
    check(`[${tag}] [키보드] 답을 고르면 초점이 다음 질문(동시 사용)으로`, (await active(page)).cls.includes('cp-question') && (await active(page)).text.includes('동시에 쓰는 기기'), JSON.stringify(await active(page)));
    await keyChoose(page, '아직 잘 모르겠어요');
    const reply = await page.locator('[data-reply]').innerText();
    check(`[${tag}] "아직 잘 모르겠어요" → 더 비싼 속도를 권하지 않고 겹치는지 먼저 살펴보라는 기준 하나`, reply.includes('더 비싼 속도부터 고르지 않아도 돼요') && reply.includes('저녁에 영상회의와 TV 시청이 겹치는지부터 살펴보세요') && !/업그레이드|더 높은 속도를 (추천|고르세요)/.test(reply), reply.slice(0, 60));
    await keyChoose(page, '가끔 봐요');
    check(`[${tag}] [키보드] 마지막 답 뒤 초점이 요약 제목으로 이동`, (await active(page)).tag === 'H2' && (await active(page)).text.includes('선택한 조건 정리'), JSON.stringify(await active(page)));
    const firstLine = await summaryFirstLine(page);
    check(`[${tag}] "잘 모르겠어요" 요약 첫 줄: 저녁에 영상회의와 TV 시청이 겹치는지(속도 추천 없음)`, firstLine.includes('저녁에 영상회의와 TV 시청이 겹치는지') && !/추천|업그레이드/.test(firstLine), firstLine.replace(/\s+/g, ' ').slice(0, 80));
    const sumU = await summaryText(page);
    check(`[${tag}] "잘 모르겠어요" 요약: 비용 구분에 숫자 없음`, sumU.includes('매달 낼 비용') && sumU.includes('설치 관련 비용') && !/\d[\d,]*\s*원/.test(sumU));
    check(`[${tag}] 가로 넘침 없음(잘 모르겠어요 요약)`, await noOverflow(page));
    await page.screenshot({ path: path.join(OUT, `05-home-unsure-summary-${width}.png`), fullPage: true });

    // 키보드로 이전 답 펼치기 → '동시 사용' 고치기
    await page.keyboard.press('Tab'); // 이전 답 보기 summary
    check(`[${tag}] [키보드] 다음 Tab이 "이전 답 보기·고치기"에 닿음`, (await active(page)).text.includes('이전 답'), JSON.stringify(await active(page)));
    await page.keyboard.press('Enter');
    check(`[${tag}] [키보드] Enter로 이전 답이 펼쳐짐`, await page.locator('details.cp-history').evaluate((e) => e.open));
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab'); // 용도 → 이유 → 동시 사용
    const onEdit = await active(page);
    check(`[${tag}] [키보드] Tab으로 "동시 사용" 고치기 버튼에 닿음`, onEdit.text === '고치기', JSON.stringify(onEdit));
    await page.keyboard.press('Enter');
    check(`[${tag}] [키보드] 고치면 낡은 요약이 바로 사라지고 그 질문으로 초점 이동`, (await summaryText(page)) === null && (await active(page)).cls.includes('cp-question') && (await active(page)).text.includes('동시에 쓰는 기기'), JSON.stringify(await active(page)));
    await keyChoose(page, '3~4개');
    await keyChoose(page, '가끔 봐요');
    const s3 = await summaryText(page);
    check(`[${tag}] [키보드] 고친 뒤 새 요약: "잘 모르겠어요" 잔재 0, 첫 줄이 동시 사용·셋톱박스 임대료로 교체`, !s3.includes('아직 잘 모르겠어요') && !s3.includes('영상회의와 TV 시청이 겹치는지') && (await summaryFirstLine(page)).includes('동시 사용과 셋톱박스 임대료'), (await summaryFirstLine(page)).replace(/\s+/g, ' ').slice(0, 70));
    const st = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
    check(`[${tag}] [키보드] 저장소·쿠키 0, 외부 요청 0, 브라우저 오류 0`, st.local === 0 && st.session === 0 && st.cookie === '' && external.length === 0 && errors.length === 0, `외부 ${external.length}, 오류 ${errors.length}`);
    await context.close();
  }

  // ── C. 사업장: 결제 흐름, 그리고 "TV 용도 미정" → 홀로 고치기 ──
  {
    const { page, context, external, errors } = await openPage(width, NOW_THU);
    await click(page, '매장·사무실용');
    check(`[${tag}] 사업장 첫 질문과 선택지가 바로 보임`, (await page.locator('.cp-current[data-step="work"]').count()) === 1 && (await currentFullyVisible(page)));
    await click(page, '카드 결제·배달 주문이 멈추는 거예요');
    check(`[${tag}] 사업장 둘째 질문(TV 용도)만 보임`, (await page.locator('.cp-current[data-step="tvuse"]').count()) === 1 && (await currentFullyVisible(page)));
    await click(page, '아직 정하지 못했어요');
    const reply = await page.locator('details.cp-history').evaluate((e) => e.textContent);
    check(`[${tag}] "아직 정하지 못했어요" 안내: 홀인지 직원 휴게실인지 정해지면 이용 조건을 비교`, reply.includes('손님이 보는 홀인지 직원 휴게실인지 정해지면 이용 조건을 비교할 수 있어요'));
    const sb = await summaryText(page);
    const fb = await summaryFirstLine(page);
    check(`[${tag}] 결제 매장 요약 첫 줄: 회선이 끊겼을 때 결제 영향과 예비 회선 필요 여부`, fb.includes('회선이 끊겼을 때 결제 영향과 예비 회선 필요 여부') && fb.includes('가장 먼저 비교할 점'), fb.replace(/\s+/g, ' ').slice(0, 80));
    check(`[${tag}] 사업장 요약에 미정 상태·확인 항목·비용 구분`, sb.includes('아직 정하지 못했어요') && sb.includes('손님이 보는 홀인지 직원 휴게실인지') && sb.includes('매달 낼 비용') && sb.includes('설치 관련 비용'));
    check(`[${tag}] 가로 넘침 없음(사업장 요약)`, await noOverflow(page));
    await page.screenshot({ path: path.join(OUT, `06-business-undecided-${width}.png`), fullPage: true });
    // 홀로 다시 고르기
    await page.locator('details.cp-history > summary').click();
    await page.locator('.cp-history-list li', { hasText: 'TV는 어디에서' }).locator('.cp-edit').click();
    check(`[${tag}] TV 용도를 고치면 요약 제거·그 질문부터 다시`, (await summaryText(page)) === null && (await page.locator('.cp-current[data-step="tvuse"]').count()) === 1 && (await active(page)).cls.includes('cp-question'));
    await click(page, '손님이 보는 홀·객실에 둬요');
    const sb2 = await summaryText(page);
    check(`[${tag}] 홀로 다시 고르면 새 요약에서 이전 미정 상태가 사라짐`, !sb2.includes('아직 정하지 못했어요') && !sb2.includes('직원 휴게실인지') && !sb2.includes('TV 용도가 정해지지 않았다면') && sb2.includes('손님이 보는 홀·객실에 둬요') && sb2.includes('해당 장소에서 이용 가능한 상품인지'));
    await context.close();
    check(`[${tag}] 사업장 흐름 외부 요청 0, 브라우저 오류 0`, external.length === 0 && errors.length === 0, `외부 ${external.length}, 오류 ${errors.length}`);
  }
}

// ── G. 광고 → 상담(PM 7018202454): 30초 광고의 설치비·설치 가능 여부·희망일정 장면을 본 고객이 가정용·사업장 상담에서 답을 찾는지 ──
const adResults = [];
const ADS = [
  { scene: '설치비', q: '설치비는 처음에 내나요?', must: ['설치비 금액과 청구 시점은 확인이 필요해요', '처음에 내는지는 지금 말씀드릴 수 없어요'], mustNot: ['나눠 내', '분할', '아니요'] },
  { scene: '설치 가능 여부', q: '우리 집이나 매장에 설치가 되는지 어떻게 알 수 있어요?', must: ['주소와 건물 조건', '주소를 받지 않아서'] },
  { scene: '희망 일정(이번 토요일)', q: '이번 토요일 설치가 확정되나요?', must: ['아직 확정된 일정이 없어요', '확정해 드릴 수 없어요'] },
  { scene: '전화 가능 요일 vs 기사 방문일', q: '전화 상담이 되는 토요일이면 그날 설치도 되나요?', must: ['전화 상담이 가능해도 설치 일정은 별도로 확인해야 해요', '별개예요', '방문 가능일'], mustNot: ['아니요', '불가능'] },
];
const SEG_FLOWS = [
  ['가정용', ['가정용', '이사해서 새로 알아봐요', '3~4개', '매일 봐요']],
  ['사업장', ['매장·사무실용', '카드 결제·배달 주문이 멈추는 거예요', '손님이 보는 홀·객실에 둬요']],
];
const STATES = [['평일(전화 안내 없음)', '2026-11-20T12:00:00+09:00', 0], ['토요일 가상 시간 안', '2026-11-21T11:00:00+09:00', 1]];
for (const width of [320, 390]) {
  for (const [segName, picks] of SEG_FLOWS) {
    for (const [stateName, iso, hasPhone] of STATES) {
      const tag = `[${width}px 광고→${segName}·${stateName}]`;
      const { page, context, external, errors } = await openPage(width, iso);
      for (const x of picks) await click(page, x);
      const sum = await summaryText(page);
      const costs = await page.$eval('.cp-costs', (e) => e.textContent).catch(() => '');
      const summaryOk = !!sum && sum.includes('설치 관련 비용') && !sum.includes('처음 낼 비용') && costs.includes('설치비 금액과 청구 시점은 확인이 필요해요') && costs.includes('확인된 금액 없음') && sum.includes('설치비와 설치 가능 여부, 희망 일정') && sum.includes('설치비 금액과 청구 시점') && !/나눠 내|분할/.test(sum) && !/\d[\d,]*\s*원/.test(sum);
      check(`${tag} 요약: 설치 관련 비용(금액·청구 시점 확인 필요)·확인할 항목에 설치 가능 여부·희망 일정·청구 시점, 분할 납부 안내·금액 숫자 없음`, summaryOk);
      await page.locator('details[data-aux="faq"] > summary').click();
      const perScene = [];
      for (const ad of ADS) {
        const item = page.locator('details[data-aux="faq"] .guide-item', { hasText: ad.q }).first();
        const found = (await item.count()) === 1;
        let shown = '';
        if (found) { await item.locator('summary').click(); shown = await item.locator('.guide-answer').innerText(); }
        const ok = found && ad.must.every((m) => shown.includes(m)) && !(ad.mustNot ?? []).some((m) => shown.includes(m)) && !/\d[\d,]*\s*원|확정됐|확정되었|접수|가입 완료/.test(shown);
        perScene.push({ scene: ad.scene, found, ok });
        check(`${tag} 광고 장면 "${ad.scene}": 접힌 도움말에서 실제 표시 답변 확인`, ok, shown.replace(/\s+/g, ' ').slice(0, 70));
      }
      const note = await page.locator('.cp-phone-note').count();
      check(`${tag} 전화 안내 영역: ${hasPhone ? '전화 가능 시간과 기사 방문일은 다르다는 구분 문구 표시' : '전화 영역 없음(구분은 도움말이 맡음)'}`, hasPhone ? note === 1 && (await page.locator('.cp-phone-note').innerText()).includes('기사가 방문할 수 있는 날은 달라요') : note === 0);
      check(`${tag} 가로 넘침 없음·외부 요청 0·저장소 0·입력칸 0·오류 0`, (await noOverflow(page)) && external.length === 0 && errors.length === 0 && (await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length)) === 0 && (await page.locator('input, textarea').count()) === 0);
      if (width === 390 && stateName.startsWith('토요일')) await page.screenshot({ path: path.join(OUT, `08-ad-${segName}-faq-390.png`), fullPage: true });
      adResults.push({ width, segment: segName, state: stateName, summaryOk, scenes: perScene });
      await context.close();
    }
  }
}
writeFileSync(path.join(OUT, 'ad-scenarios.json'), JSON.stringify(adResults, null, 2));

// ── D. 보조 FAQ는 접어서 읽는다(펼치면 보임) ──
{
  const { page, context } = await openPage(390, NOW_THU);
  await page.locator('details[data-aux="faq"] > summary').click();
  check('[390px] FAQ 펼치면 질문 7개, 각 항목은 다시 접힌 상태', (await page.locator('details[data-aux="faq"] .guide-item').count()) === 7 && (await page.locator('details[data-aux="faq"] .guide-item[open]').count()) === 0);
  await page.locator('details[data-aux="privacy"] > summary').click();
  for (const s of await page.locator('details[data-aux="privacy"] .guide-item > summary').all()) await s.click();
  const priv = await page.locator('details[data-aux="privacy"]').innerText();
  check('[390px] 개인정보 안내: 지금 입력할 정보 없음·처리하는 곳·보관 기간·동의 방법', priv.includes('아무것도 입력하지 않아요') && priv.includes('처리하는 곳') && priv.includes('보관 기간') && priv.includes('동의 방법'));
  await page.locator('details[data-aux="examples"] > summary').click();
  const ex = await page.locator('details[data-aux="examples"]').innerText();
  check('[390px] 승인된 두 상담 예시 문구 표시', ex.includes('지금은 금액이나 일정을 확정해 드릴 수 없어요.') && ex.includes('현재 담당자 연결을 확인할 수 없어요.'));
  await context.close();
}

// ── E. 모션 축소 설정 존중 ──
for (const [label, rm, expectName] of [['축소 선택', 'reduce', 'none'], ['기본', 'no-preference', 'cp-in']]) {
  const { page, context } = await openPage(390, NOW_THU, { reducedMotion: rm });
  const name = await page.locator('.cp-now').first().evaluate((e) => getComputedStyle(e).animationName);
  check(`[모션] ${label}: 등장 애니메이션 ${expectName === 'none' ? '없음' : '있음'}`, name === expectName, name);
  await context.close();
}

// ── F. 평일·주말·시간 경계(한국 시간): 가짜 시계 + 컴포넌트의 실제 시계 경로 ──
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
  check(`[시각] ${label}: 전화 안내 ${want.section ? '있음' : '숨김'}, 모의 전화 버튼 ${want.btn ? '있음' : '없음'}`, r.section === want.section && r.btn === want.btn, r.text.replace(/\s+/g, ' ').slice(0, 60));
  if (label === '일요일 12:00') check('[시각] 일요일은 토요일 운영 안내만', r.text.includes('토요일 10:00~16:00') && r.text.includes('가상 시간'));
  if (label === '토요일 10:00') {
    await r.page.screenshot({ path: path.join(OUT, '07-saturday-open-390.png'), fullPage: true });
    await r.page.getByRole('button', { name: '모의 전화 버튼' }).click();
    const t = await r.page.locator('.cp-mock-result').innerText();
    check('[시각] 모의 전화 버튼은 안내만 표시(실제 전화·전달 아님), 외부 요청 0', t.includes('실제로 전화가 걸리거나 담당자에게 전달되지 않아요') && r.page.url() === `${ORIGIN}/` && r.external.length === 0);
  }
  check(`[시각] ${label}: 브라우저 오류·외부 요청 0`, r.errors.length === 0 && r.external.length === 0);
  await r.context.close();
}

// 열린 채로 16:00을 넘기면 버튼이 사라진다(실제 30초 타이머 경로)
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
check('[시각] 브라우저 시간대가 한국이 아니어도(뉴욕) 한국 시간으로 판단', results.filter((r) => r.name.startsWith('[시각] 토요일 10:00')).every((r) => r.pass));

await browser.close();
const failed = results.filter((r) => !r.pass);
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (failed.length > 0) {
  console.error(`실패 ${failed.length}건: ${failed.map((f) => f.name).join(' ; ')}`);
  process.exit(1);
}
