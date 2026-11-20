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

// 화면 전환(0.18초 나타남 효과) 도중에 찍으면 흐리게 보인다. 모든 효과가 끝나고 두 프레임이 지난 뒤에 찍는다.
const settle = (page) => page.evaluate(async () => { await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
const shot = async (page, file) => { await settle(page); await page.screenshot({ path: file, fullPage: true }); };
// 글자 대비(실제 계산된 색, 투명 배경은 위 조상으로 올라가며 합성)와 초점 표시
const contrastOf = (page, selector) => page.$$eval(selector, (els) => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x)); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { let cur = el; let base = { r: 255, g: 255, b: 255 }; const stack = []; while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } cur = cur.parentElement; } for (const c of stack.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; return base; };
  return els.map((el) => { const st = getComputedStyle(el); const fg = parse(st.color); const bg = bgOf(el); let op = 1; for (let c = el; c; c = c.parentElement) op *= parseFloat(getComputedStyle(c).opacity); const f = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg; const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); return { ratio, op, text: (el.textContent || '').trim().slice(0, 24) }; });
});
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
    await shot(page, path.join(OUT, `03-home-summary-${width}.png`));

    // 이전 답 펼쳐서 고치기(포인터)
    await page.locator('details.cp-history > summary').click();
    check(`[${tag}] 이전 답 펼치면 답 4개(용도+질문 3개)와 고치기 버튼`, (await page.locator('.cp-history .cp-edit').count()) === 4);
    const spEdit = await spacing(page, '.cp-history .cp-edit');
    check(`[${tag}] 고치기 버튼 높이·너비 ≥44px`, spEdit.minH >= 44 && spEdit.minW >= 44, `높이 ${Math.round(spEdit.minH)}, 너비 ${Math.round(spEdit.minW)}`);
    await shot(page, path.join(OUT, `04-history-open-${width}.png`));
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
    await shot(page, path.join(OUT, `05-home-unsure-summary-${width}.png`));

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
    await shot(page, path.join(OUT, `06-business-undecided-${width}.png`));
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
      const summaryOk = !!sum && sum.includes('설치 관련 비용') && !sum.includes('처음 낼 비용') && costs.includes('설치비 금액과 청구 시점은 확인이 필요해요') && costs.includes('확인된 금액 없음') && sum.includes('설치 가능 여부, 희망 일정, 설치비 금액과 청구 시점') && !/나눠 내|분할/.test(sum) && !/\d[\d,]*\s*원/.test(sum);
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
      if (width === 390 && stateName.startsWith('토요일')) await shot(page, path.join(OUT, `08-ad-${segName}-faq-390.png`));
      adResults.push({ width, segment: segName, state: stateName, summaryOk, scenes: perScene });
      await context.close();
    }
  }
}
writeFileSync(path.join(OUT, 'ad-scenarios.json'), JSON.stringify(adResults, null, 2));

// ── G2. 이사 대표 경로(moving → few → rare): 첫 줄과 요약에서 금액·청구 시점 확인 안내가 보이고 "처음 내는 비용" 단정이 없다(PM 7020585092) ──
for (const width of [320, 390]) {
  const { page, context, external, errors } = await openPage(width, NOW_THU);
  for (const x of ['가정용', '이사해서 새로 알아봐요', '1~2개', '거의 안 봐요']) await click(page, x);
  const first = await summaryFirstLine(page);
  const all = await summaryText(page);
  check(`[${width}px] 이사 대표 경로 첫 줄: 설치 가능 여부와 설치비 + "설치비 금액과 청구 시점도 확인해 보세요"`, first.includes('설치 가능 여부와 설치비') && first.includes('새 주소의 건물 조건에 따라 설치 가능 여부가 달라져요') && first.includes('설치비 금액과 청구 시점도 확인해 보세요'), first.replace(/\s+/g, ' ').slice(0, 90));
  check(`[${width}px] 이사 대표 경로 요약: 설치 관련 비용·확인 항목에 금액과 청구 시점, "처음 내는/낼 비용" 단정 없음`, all.includes('설치 관련 비용') && all.includes('설치비 금액과 청구 시점은 확인이 필요해요') && all.includes('설치 가능 여부, 희망 일정, 설치비 금액과 청구 시점') && !/처음 (낼|내는|내요|내나)|나눠 내|분할/.test(all));
  check(`[${width}px] 이사 대표 경로 가로 넘침·외부 요청·오류 0`, (await noOverflow(page)) && external.length === 0 && errors.length === 0);
  await context.close();
}

// ── G3. 광고 나머지 비교 기준(PM 7021402686): 사은품만 보고 고름 / 월 요금·약정 함께 / 속도 모름. 답을 찾은 위치와 화면에 실제 표시된 다음 확인 사항을 기록한다 ──
const critResults = [];
const MONEY = /\d[\d,]*\s*원|무료|할인|혜택|지원금|최저가|추천/;
for (const width of [320, 390]) {
  for (const [segName, picks, forbidden] of [
    ['가정용', ['가정용', '쓰던 약정이 끝나서 비교해요', '아직 잘 모르겠어요', '거의 안 봐요'], null],
    ['사업장', ['매장·사무실용', '업무와 화상회의가 멈추는 거예요', '손님이 보는 홀·객실에 둬요'], /가정|우리 집|집에서|저녁에 영상회의/],
  ]) {
    const tag = `[${width}px 광고 비교기준→${segName}]`;
    const { page, context, external, errors } = await openPage(width, NOW_THU);
    const faq = async (q) => {
      const det = page.locator('details[data-aux="faq"]');
      if (!(await det.evaluate((e) => e.open))) await det.locator('> summary').click();
      const item = det.locator('.guide-item', { hasText: q }).first();
      if (!(await item.evaluate((e) => e.open))) await item.locator('summary').click();
      return item.locator('.guide-answer').innerText();
    };
    // 선택 전(첫 화면)에서 도움말로 찾는 경우
    const gift = await faq('사은품은 어디가 더 많아요?');
    const giftOk = ['같은 약정 기간', '월 요금', '장비 비용', '설치비', '지급 조건'].every((k) => gift.includes(k)) && !MONEY.test(gift);
    check(`${tag} (1)사은품만 보고 고름 → 도움말(선택 전): 같은 약정 기간으로 월 요금·장비 비용·설치비·지급 조건 확인`, giftOk, gift.replace(/\s+/g, ' ').slice(0, 60));
    const speed = await faq('500메가면 충분해요?');
    const speedOk = speed.includes('속도를 아직 모르면 속도부터 고르지 말고') && speed.includes('저녁에 영상회의와 TV 시청이 겹치는지') && speed.includes('바쁜 시간에 겹치는 작업과 장애 대응 조건') && !speed.includes('위에서 고른') && !MONEY.test(speed);
    check(`${tag} (3)속도 모름 → 도움말(선택 전): 속도부터 고르지 않고 겹침·장애 대응 조건 확인, "위에서 고른 조건" 참조 없음`, speedOk, speed.replace(/\s+/g, ' ').slice(0, 60));
    // 선택 경로 끝까지 → 요약
    for (const x of picks) await click(page, x);
    const sum = await summaryText(page);
    const first = await summaryFirstLine(page);
    const toCheckOk = sum.includes('월 요금과 약정 기간(VAT 포함 여부 구분)') && sum.includes('장비 비용과 사은품 지급 조건(조건이 확인된 것만 비교)');
    check(`${tag} (1)(2)요약 확인할 항목: 월 요금과 약정 기간·장비 비용과 사은품 지급 조건`, toCheckOk);
    const costs = await page.$eval('.cp-costs', (e) => e.textContent);
    check(`${tag} (2)비용 표: 매달 낼 비용에 월 요금, 금액 숫자 없음`, costs.includes('매달 낼 비용') && costs.includes('월 요금') && !/\d/.test(costs));
    const speedPoint = segName === '가정용' ? first.includes('저녁에 영상회의와 TV 시청이 겹치는지') : first.includes('바쁜 시간에 겹치는 작업과 장애 대응 조건');
    check(`${tag} (3)속도 모름 → 요약 첫 줄이 다음 확인 사항(속도 추천 아님)`, speedPoint && !MONEY.test(first), first.replace(/\s+/g, ' ').slice(0, 70));
    if (forbidden) check(`${tag} 사업장 요약·질문 화면에 가정용 조건 문구 없음`, !forbidden.test(sum) && !forbidden.test(first));
    check(`${tag} 가격·혜택 확정 문구 없음(요약)`, !MONEY.test(sum.replace('견적이나 접수가 아니에요', '')), (MONEY.exec(sum) ?? [''])[0]);
    check(`${tag} 가로 넘침·외부 요청·저장소·오류 0`, (await noOverflow(page)) && external.length === 0 && errors.length === 0 && (await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length)) === 0);
    critResults.push({ width, segment: segName, gift: { where: 'FAQ 사은품은 어디가 더 많아요?(선택 전) + 요약 확인할 항목', ok: giftOk && toCheckOk }, monthlyAndTerm: { where: '요약 비용 표(매달 낼 비용)·확인할 항목(월 요금과 약정 기간)', ok: toCheckOk }, speedUnknown: { where: 'FAQ 500메가면 충분해요?(선택 전) + 요약 첫 줄', ok: speedOk && speedPoint } });
    await context.close();
  }
}
writeFileSync(path.join(OUT, 'ad-criteria.json'), JSON.stringify(critResults, null, 2));

// ── G4. 확인할 항목 순서·중복·줄바꿈(PM 7024149005): 320/390 × 가정용(이사·갱신)·사업장, 선택 변경 후 이전 조건 제거 ──
const toCheckLines = (page) => page.$$eval('.cp-summary h3', (hs) => {
  const h = hs.find((x) => x.textContent === '확인할 항목');
  return [...h.nextElementSibling.querySelectorAll('li')].map((li) => li.textContent.trim());
});
const INSTALL_LINE = '설치 가능 여부, 희망 일정, 설치비 금액과 청구 시점';
const PRICE_LINE = '월 요금과 약정 기간(VAT 포함 여부 구분)';
const GIFT_LINE = '장비 비용과 사은품 지급 조건(조건이 확인된 것만 비교)';
for (const width of [320, 390]) {
  for (const [name, picks] of [
    ['가정용 이사', ['가정용', '이사해서 새로 알아봐요', '3~4개', '매일 봐요']],
    ['가정용 약정 갱신', ['가정용', '쓰던 약정이 끝나서 비교해요', '5개 이상', '가끔 봐요']],
    ['사업장 결제', ['매장·사무실용', '카드 결제·배달 주문이 멈추는 거예요', '손님이 보는 홀·객실에 둬요']],
  ]) {
    const tag = `[${width}px ${name}]`;
    const { page, context, external, errors } = await openPage(width, NOW_THU);
    for (const x of picks) await click(page, x);
    const lines = await toCheckLines(page);
    const isHome = name.startsWith('가정용');
    const installN = lines.filter((t) => /설치 가능 여부|희망 일정|희망하는 설치 일정|설치비/.test(t)).length;
    check(`${tag} 확인할 항목: 설치 질문은 한 줄 한 번(${INSTALL_LINE}), 중복 줄 없음`, installN === 1 && lines.includes(INSTALL_LINE) && new Set(lines).size === lines.length, `${lines.length}줄`);
    check(`${tag} 확인할 항목: ${isHome ? '월 요금·약정(VAT)이 첫 줄' : '결제·장애 대응 선택 항목이 월 요금 줄보다 앞'}`, isHome ? lines[0] === PRICE_LINE : lines.indexOf('결제·주문 장비 종류와 개수') === 0 && lines.indexOf(PRICE_LINE) > lines.indexOf('장애가 났을 때 대응 조건'), lines.slice(0, 2).join(' | ').slice(0, 70));
    check(`${tag} 확인할 항목: 마지막 두 줄은 설치(한 줄)·장비·사은품`, lines.slice(-2).join('|') === `${INSTALL_LINE}|${GIFT_LINE}`);
    if (name === '가정용 이사') check(`${tag} 선택에 따른 기기·이용 방식·TV 조건 보존(동시 사용·공유기, TV 이용료)`, ['동시에 겹치는 사용(영상 시청·화상회의·게임)', '공유기 위치와 성능', 'TV 이용료와 셋톱박스 비용'].every((t) => lines.includes(t)) && lines.indexOf(PRICE_LINE) === 0);
    const wrap = await page.$eval('.cp-summary li', (e) => { const c = getComputedStyle(e); return { wb: c.wordBreak, ow: c.overflowWrap }; });
    check(`${tag} 요약 목록 줄바꿈: 단어 단위(keep-all)·비상 줄바꿈(anywhere)`, wrap.wb === 'keep-all' && wrap.ow === 'anywhere', JSON.stringify(wrap));
    // 한글 단어 중간 줄바꿈 점검: 각 li의 모든 줄 시작이 단어(공백 뒤)이거나 첫 글자인지, Range로 줄 단위 텍스트를 읽어 확인
    const mid = await page.$$eval('.cp-summary li', (lis) => {
      let bad = 0;
      for (const li of lis) {
        const node = li.firstChild;
        if (!node || node.nodeType !== 3) continue;
        const text = node.textContent;
        const r = document.createRange();
        let prevTop = null;
        for (let i = 0; i < text.length; i++) {
          r.setStart(node, i); r.setEnd(node, i + 1);
          const rect = r.getClientRects()[0];
          if (!rect) continue;
          if (prevTop !== null && rect.top > prevTop + 4 && i > 0 && text[i - 1] !== ' ' && /[가-힣]/.test(text[i - 1]) && /[가-힣]/.test(text[i])) bad++;
          prevTop = rect.top;
        }
      }
      return bad;
    });
    check(`${tag} 요약 목록에 한글 단어 중간 줄바꿈 0`, mid === 0, `${mid}곳`);
    check(`${tag} 첫 비교 항목 유지(가장 먼저 비교할 점)·비용 표 유지(확인된 금액 없음 2칸)`, (await summaryFirstLine(page)).includes('가장 먼저 비교할 점') && (await page.locator('.cp-costs li').count()) === 2 && (await page.locator('.cp-costs .cp-cost-status', { hasText: '확인된 금액 없음' }).count()) === 2);
    check(`${tag} 가로 넘침·외부 요청·저장소·오류 0`, (await noOverflow(page)) && external.length === 0 && errors.length === 0 && (await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length)) === 0);
    if (width === 390) await page.screenshot({ path: path.join(OUT, `09-tocheck-${name.replace(/ /g, '-')}-390.png`), fullPage: true });
    // 선택 변경: 기기 수 → 이전 조건 제거(가정용만)
    if (isHome) {
      await page.locator('details.cp-history > summary').click();
      await page.locator('.cp-history-list li', { hasText: '동시에 쓰는 기기' }).locator('.cp-edit').click();
      check(`${tag} 선택 변경 직후 낡은 요약 제거`, (await summaryText(page)) === null);
      await click(page, '1~2개');
      await click(page, '거의 안 봐요');
      const l2 = await toCheckLines(page);
      check(`${tag} 변경 후 새 요약: 이전 조건(공유기 위치·TV 이용료 등) 제거, 새 조건(와이파이 약한 방) 반영, 월 요금 첫 줄·설치 한 줄 유지`, !l2.includes('공유기 위치와 성능') && !l2.includes('TV 이용료와 셋톱박스 비용') && l2.includes('집에서 와이파이가 약한 방이 있는지') && l2[0] === PRICE_LINE && l2.filter((t) => /설치 가능 여부|희망 일정|설치비/.test(t)).length === 1);
    }
    await context.close();
  }
}

// ── G6. 광고 시안 → 이사 상담(PM): 버튼 하나로 이사가 선택된 상태로 시작, 기존 인터넷 유무 선택 → 요약, 선택을 바꾸면 요약 갱신 ──
for (const width of [320, 390]) {
  const tag = `[${width}px 이사 광고→상담]`;
  const { page, context, external, errors } = await openPage(width, NOW_THU);
  check(`${tag} 시작 화면에 광고 시안(미게시 초안)과 '이사 전 확인 목록 보기' 버튼, 입력칸·링크 없음`, (await page.locator('[data-ad-draft="moving"] .cp-ad-cta').innerText()) === '이사 전 확인 목록 보기' && (await page.locator('[data-ad-draft]').innerText()).includes('미게시 초안') && (await page.locator('input, textarea, a[href]').count()) === 0);
  await page.locator('.cp-ad-cta').focus();
  await page.keyboard.press('Enter');
  const step = await page.locator('.cp-current').getAttribute('data-step');
  const act = await page.evaluate(() => document.activeElement.className);
  const hist = await page.locator('details.cp-history').evaluate((e) => e.textContent);
  check(`${tag} [키보드 Enter] 가정용·이사가 이미 선택된 채 "지금 쓰는 인터넷이 있나요?"부터 묻고, 이사 안내 답이 보이고 초점이 질문으로`, step === 'existing' && act.includes('cp-question') && (await page.locator('.cp-bubble[data-reply]').innerText()).includes('이사를 앞두고 계시군요') && hist.includes('이사해서 새로 알아봐요') && (await page.locator('.cp-progress').innerText()).includes('질문 2/4'));
  await shot(page, path.join(OUT, `11-ad-moving-start-${width}.png`));
  await settle(page);
  const qc = await contrastOf(page, '.cp-current .cp-question, .cp-current .cp-choice, .cp-current .cp-progress, .cp-bubble[data-reply] p');
  check(`${tag} 전환이 끝난 뒤 질문·선택지·안내 글자 대비 ≥4.5:1, 투명도 1(흐림 없음)`, qc.length >= 4 && qc.every((x) => x.ratio >= 4.5 && x.op === 1), qc.map((x) => `${x.ratio.toFixed(1)}/${x.op}`).join(' '));
  await page.locator('.cp-current .cp-choice').first().focus();
  const fo = await page.evaluate(() => { const e = document.activeElement; const st = getComputedStyle(e); const r = e.getBoundingClientRect(); return { outline: st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 2, inView: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth }; });
  check(`${tag} [키보드] 선택지 초점 표시(윤곽선 ≥2px)가 보이고 화면 안`, fo.outline && fo.inView);
  await click(page, '지금 쓰는 인터넷이 있어요');
  await click(page, '3~4개');
  await click(page, '매일 봐요');
  const sHas = await summaryText(page);
  const kpHas = await summaryFirstLine(page);
  check(`${tag} "있어요" 요약 맨 위: 약정 종료일과 이전·해지 비용 비교`, kpHas.includes('가장 먼저 비교할 점') && kpHas.includes('약정 종료일과 이전·해지 비용 비교'), kpHas.replace(/\s+/g, ' ').slice(0, 60));
  await settle(page);
  const sc = await contrastOf(page, '.cp-summary .cp-keypoint strong, .cp-summary .cp-keypoint-label, .cp-summary .cp-keypoint-reason, .cp-summary li, .cp-summary h3');
  check(`${tag} 요약 글자 대비 ≥4.5:1, 흐림 없음`, sc.length > 5 && sc.every((x) => x.ratio >= 4.5 && x.op === 1), `최저 ${Math.min(...sc.map((x) => x.ratio)).toFixed(1)}`);
  check(`${tag} 쓰는 인터넷 "있어요" 요약: 선택 조건과 이전·해지 확인 항목 표시`, !!sHas && sHas.includes('지금 쓰는 인터넷이 있어요') && sHas.includes('지금 쓰는 인터넷의 약정 종료 시기와 이전·해지 조건') && sHas.includes('이사해서 새로 알아봐요') && sHas.includes('설치 가능 여부, 희망 일정, 설치비 금액과 청구 시점'));
  await shot(page, path.join(OUT, `12-ad-moving-has-${width}.png`));
  await page.locator('details.cp-history > summary').click();
  await page.locator('.cp-history-list li', { hasText: '지금 쓰는 인터넷이 있나요' }).locator('.cp-edit').click();
  check(`${tag} 선택을 고치면 낡은 요약이 사라지고 그 질문부터 다시`, (await summaryText(page)) === null && (await page.locator('.cp-current[data-step="existing"]').count()) === 1);
  await click(page, '지금은 없어요');
  await click(page, '3~4개');
  await click(page, '매일 봐요');
  const sNone = await summaryText(page);
  const kpNone = await summaryFirstLine(page);
  check(`${tag} "없어요" 요약 맨 위: 설치 가능일과 설치비 금액·청구 시점 확인, 이전 "있어요" 안내(약정 종료일·이전·해지 비용)는 사라짐`, kpNone.includes('설치 가능일과 설치비 금액·청구 시점 확인') && !kpNone.includes('약정 종료일') && !(await summaryText(page)).includes('이전·해지'), kpNone.replace(/\s+/g, ' ').slice(0, 60));
  check(`${tag} "없어요"로 바꾸면 요약이 갱신: 새 선택 표시, 이전·해지 항목과 "있어요" 문구 사라짐`, !!sNone && sNone.includes('지금은 없어요') && !sNone.includes('지금 쓰는 인터넷이 있어요') && !sNone.includes('이전·해지 조건') && sNone.includes('이사해서 새로 알아봐요'));
  await shot(page, path.join(OUT, `13-ad-moving-none-${width}.png`));
  // 처음 화면으로 돌아가 일반 가정용 흐름은 그대로(질문 3개, 쓰는 인터넷 질문 없음)
  await page.locator('details.cp-history > summary').click();
  await page.locator('.cp-history-list li', { hasText: '집에서 쓰실 건가요' }).locator('.cp-edit').click();
  await click(page, '가정용');
  await click(page, '이사해서 새로 알아봐요');
  check(`${tag} 일반 상담으로 다시 시작하면 질문 3개 흐름 그대로(쓰는 인터넷 질문 없음)`, (await page.locator('.cp-progress').innerText()).includes('질문 2/3') && (await page.locator('.cp-current[data-step="devices"]').count()) === 1);
  check(`${tag} 가로 넘침 없음·외부 요청 0·저장소 0·입력칸 0·오류 0`, (await noOverflow(page)) && external.length === 0 && errors.length === 0 && (await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length)) === 0 && (await page.locator('input, textarea').count()) === 0, `외부 ${external.length}`);
  await context.close();
}

// ── G5. 담당자 연결 모의 예시(PM 7029405014): 접힌 예시 안에서 네 사례를 키보드로 전환·반복 선택, 한 번에 안내 하나만, 모의 확인 옆 표시 ──
const HANDOFF_EXPECT = {
  off: '토요일 설치 가능 여부는 지금 확인해 드릴 수 없어요',
  unavailable: '현재 담당자 연결을 확인할 수 없어요',
  unknown: '담당자에게 전달됐는지 확인하지 못했어요',
  confirmed: '담당자가 이 문의를 확인했어요',
};
const HANDOFF_SEQ = ['off', 'unavailable', 'unknown', 'confirmed', 'confirmed', 'unknown', 'off', 'confirmed'];
for (const width of [320, 390]) {
  const tag = `[${width}px 담당자 연결 모의 예시]`;
  const { page, context, external, errors } = await openPage(width, NOW_THU);
  await page.locator('details[data-aux="examples"] > summary').click();
  const foldClosed = !(await page.locator('details[data-handoff-fold]').evaluate((e) => e.open));
  check(`${tag} 기존 질문 예시 안에 접힌 상태로 있음`, foldClosed && (await page.locator('details[data-aux="examples"] details[data-handoff-fold]').count()) === 1);
  await page.locator('details[data-handoff-fold] > summary').click();
  check(`${tag} 펼치면 안내문(실제 전송 없음)·고객 질문·사례 버튼 4개, 사례를 고르기 전엔 결과 0`, (await page.locator('.cp-handoff-note').innerText()).includes('실제로 전송되지 않아요') && (await page.locator('.cp-handoff-case').count()) === 4 && (await page.locator('[data-handoff-result]').count()) === 0);
  const sp = await spacing(page, '.cp-handoff-case');
  check(`${tag} 사례 버튼 높이 ≥44px·간격 ≥8px`, sp.minH >= 44 && sp.minGap >= 8, `높이 ${Math.round(sp.minH)}, 간격 ${sp.minGap}`);
  // 키보드: 첫 사례에 초점을 두고 Tab 순서가 네 사례 순서인지
  await page.locator('.cp-handoff-case').first().focus();
  const order = [await page.evaluate(() => document.activeElement.dataset.case)];
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.dataset.case)); }
  check(`${tag} [키보드] Tab 순서: 경로 꺼짐 → 연결 확인 불가 → 전달 결과 불명 → 모의 확인`, order.join('>') === 'off>unavailable>unknown>confirmed', order.join('>'));
  let allOk = true; const notes = [];
  for (const [i, id] of HANDOFF_SEQ.entries()) {
    await page.locator(`[data-case="${id}"]`).focus();
    await page.keyboard.press(i % 2 === 0 ? 'Enter' : 'Space');
    const count = await page.locator('[data-handoff-result]').count();
    const which = await page.locator('[data-handoff-result]').getAttribute('data-handoff-result');
    const text = await page.locator('[data-handoff-result]').innerText();
    const others = Object.entries(HANDOFF_EXPECT).filter(([k]) => k !== id).some(([, v]) => text.includes(v));
    const badge = await page.locator('.cp-handoff-mock').count();
    const badgeOk = id === 'confirmed' ? badge === 1 && (await page.locator('.cp-handoff-mock').innerText()) === '모의 결과 · 실제 문의 전송 없음' && (await page.locator('.cp-handoff-mock').evaluate((e) => e.parentElement.textContent.includes('담당자가 이 문의를 확인했어요'))) : badge === 0;
    const pressed = await page.$$eval('.cp-handoff-case', (els) => els.filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.dataset.case));
    const clip = await page.$$eval('[data-handoff-result], [data-handoff-result] p, .cp-handoff-mock', (els) => els.every((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= window.innerWidth + 0.5 && e.getBoundingClientRect().left >= -0.5));
    const ok = count === 1 && which === id && text.includes(HANDOFF_EXPECT[id]) && !others && badgeOk && pressed.length === 1 && pressed[0] === id && clip && (await noOverflow(page));
    if (!ok) { allOk = false; notes.push(`${i}:${id} count=${count} which=${which} others=${others} badge=${badge} pressed=${pressed} clip=${clip}`); }
  }
  check(`${tag} [키보드 Enter/Space] 사례 전환·반복 선택(8회): 매번 해당 안내 하나만, 모의 확인에만 표시(같은 문단), 문구 잘림·가로 넘침 0`, allOk, notes.join(' | '));
  await page.locator('[data-case="confirmed"]').focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-handoff-result]').scrollIntoViewIfNeeded();
  await shot(page, path.join(OUT, `10-handoff-confirmed-${width}.png`));
  check(`${tag} 선택으로 발생한 외부 요청 0·저장소 0·입력칸 0·링크 0·오류 0`, external.length === 0 && errors.length === 0 && (await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length)) === 0 && (await page.locator('input, textarea').count()) === 0 && (await page.locator('a[href]').count()) === 0, `외부 ${external.length}건`);
  await context.close();
}

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
