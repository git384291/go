// Next.js 설치 없이 페이지 컴포넌트를 정적 HTML로 렌더링하고 모바일 화면을 캡처한다(미리보기·검수용).
// 실제 빌드·라우팅 검증은 Next.js 설치 후 `npm run build`로 한다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { chromium } from 'playwright';
import RootLayout from '../../src/app/layout';
import Home from '../../src/app/page';
import InternetTv from '../../src/app/products/internet-tv/page';
import InternetPhone from '../../src/app/products/internet-phone/page';
import Cctv from '../../src/app/products/cctv-security/page';
import Consult from '../../src/app/consult/page';
import { AdminMockView } from '../../src/app/admin/AdminMockView';
import { LoginPreview } from '../../src/app/admin/login/LoginPreview';
import { ProgressView } from '../../src/app/admin/progress/ProgressView';
import { LeadsReadLocked, LeadsReadView } from '../../src/app/admin/LeadsReadView';
import { AdBudgetLocked, AdBudgetView, type BudgetRow } from '../../src/app/admin/ads/AdBudgetView';
import { PolicyAdminView, PolicyLocked, type PolicyRow } from '../../src/app/admin/policies/PolicyAdminView';
import { PageShell } from '../../src/components/Site';
import { OfficialIntakeCta } from '../../src/components/OfficialIntakeCta';
import { resolveOfficialIntake, type OfficialIntakeResult } from '../../src/content/officialIntake';
import { ProductGuidePanel } from '../../src/components/ProductGuidePanel';
import { GUIDE_TOPICS } from '../../src/content/productGuide';
import type { Page } from 'playwright';
import { ProductPage } from '../../src/components/ProductPage';
import { ConsultForm } from '../../src/components/ConsultForm';
import { resolveKakaoInquiry } from '../../src/content/kakaoInquiry';
import { KAKAO_INQUIRY_NOTES } from '../../src/content/channels';

// 진행판 미리보기는 실제 서버 스냅샷이 아닌 화면 확인용 고정 예시를 쓴다(가로 넘침·표시 확인)
const PROGRESS_FIXTURE = {
  checkedAt: '2026-11-16T02:03:00+09:00', staleAfterHours: 24,
  stage: '1단계 — 관리자 로그인·보안 준비 (서비스 비공개, 고객 접수 꺼짐)',
  recentDone: ['관리자 로그인 절차(비밀번호 → 인증 앱 → 서버 확인) 연결, 기본 꺼짐', '가상 데이터 상담 목록 조회(대표 전체·상담원 본인 배정만)'],
  next: ['검색 노출 준비(공개 전 닫힌 기본값 유지)'],
  checks: [{ name: '화면·API 경로 검사(건너뜀 없음)', passed: true }, { name: '실제 로그인 서버 연결 검사', passed: null }],
  sales: { label: '실제 상담 접수 실적', value: null },
};

const READ_ACTOR = '00000000-0000-4000-8000-000000000001';
const READ_FIXTURE = [
  { id: '10000000-0000-4000-8000-000000000001', createdAt: '2026-11-16T00:00:01.000Z', nameMasked: '남궁**수', phoneMasked: '010-****-1001', interest: 'internet_tv', status: 'no_answer', assignedTo: READ_ACTOR },
  { id: '10000000-0000-4000-8000-000000000002', createdAt: '2026-11-15T23:59:00.000Z', nameMasked: 'J********h', phoneMasked: '010-****-1002', interest: 'internet_tv', status: 'converted', assignedTo: null },
] as const;

// PHASE 1: 고객 화면에 나오면 안 되는 예약 상품 흔적(관리자 화면은 내부 가상 데이터라 제외)
const FORBIDDEN = ['/products/internet-phone', '/products/cctv-security', '/products/mobile', '집전화', 'CCTV', 'cctv',
  'internet_phone', 'cctv_security', 'internet_only', 'value="other"', '동판'];
// PHASE 1 보완: 외부 상담 채널(카카오톡) 버튼·안내·링크가 모든 화면에서 없어야 한다
const EXTERNAL_CHANNEL = ['카카오', 'btn-kakao', '#kakao-channel', 'pf.kakao.com', 'open.kakao.com'];
// Mac 검증 보완 ⑧: 접수가 꺼진 동안 접수 가능으로 오해할 문구 금지, 준비 중 안내 필수
const INTAKE_PHRASES = ['무료 상담 신청', '연락처만 남겨', '이 상품으로 상담 신청', '상담 신청하기', '남기면 됩니다', '연락드려'];
const NOTICE = '온라인 상담 서비스 준비 중';
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

// 공식 접수처 연결 표시 확인용 가상 등록부(실제 목적지 아님, example.com은 IANA 예시 도메인). 실제 설정은 꺼짐·빈 등록부다.
const FAKE_INTAKE = resolveOfficialIntake({
  enabled: true,
  slug: 'internet-tv',
  registry: [
    { id: 'fake-a', label: '가상 접수처 A', url: 'https://intake-a.example.com/apply', products: ['internet-tv'], reviewRef: 'PM-000000' },
    { id: 'fake-b', label: '가상 접수처 B (긴 이름 표시 확인)', url: 'https://very-long-subdomain-for-wrap-check.intake-b.example.com/internet-tv/apply', products: ['internet-tv'], reviewRef: 'PM-000000' },
  ],
});
const FAKE_HREFS = ['https://intake-a.example.com/apply', 'https://very-long-subdomain-for-wrap-check.intake-b.example.com/internet-tv/apply'];

// 카카오톡 상품 문의 가상 켜짐(실제 설정은 전역 gate·문의 스위치 모두 false). 가짜 링크는 열지 않는다
const FAKE_KAKAO_HREF = 'https://pf.kakao.com/_fixture0000/chat';
const FAKE_KAKAO = resolveKakaoInquiry({ globalGate: true, enabled: true, url: FAKE_KAKAO_HREF, reviewRef: 'PM-000000' });
let consultInputBaseline = -1;

const INTAKE_OFF: OfficialIntakeResult = { state: 'off', reason: 'DISABLED' };
const GUARANTEE = /최저|무료|당일|보장|100%|AI 상담 중|상담원 연결됨/;

/** 상품 안내 패널 실브라우저 조작: details/summary 펼침·닫기·반복·키보드·초점·주소 불변·요청 0·신청 안내 상태 */
async function guideInteraction(page: Page, intakeOn: boolean, requests: () => number): Promise<string> {
  const startUrl = page.url();
  const req0 = requests();
  const topics = await page.$$eval('[data-product-guide] details', (ds) => ds.map((d) => d.getAttribute('data-guide-topic')));
  const nine = JSON.stringify(topics) === JSON.stringify([...GUIDE_TOPICS]);
  const allClosed = await page.$$eval('[data-product-guide] details', (ds) => ds.every((d) => !(d as HTMLDetailsElement).open));
  const openAt = (i: number) => page.$$eval('[data-product-guide] details', (ds, k) => (ds[k] as HTMLDetailsElement).open, i);
  const summaries = page.locator('[data-product-guide] summary');
  // 펼침·닫기 반복 클릭(모든 주제, 3회)
  let clicks = true;
  for (let i = 0; i < topics.length; i++) {
    for (let k = 0; k < 3; k++) {
      await summaries.nth(i).click();
      clicks &&= await openAt(i);
      await summaries.nth(i).click();
      clicks &&= !(await openAt(i));
    }
  }
  // 키보드: Enter 펼침, Space 닫기, 초점은 summary에 유지, Tab은 다음 summary로
  const active = () => page.evaluate(() => {
    const a = document.activeElement;
    return a && a.tagName === 'SUMMARY' ? a.closest('details')?.getAttribute('data-guide-topic') ?? null : a?.tagName ?? null;
  });
  let keys = true;
  await summaries.nth(0).focus();
  keys &&= (await active()) === GUIDE_TOPICS[0];
  await page.keyboard.press('Enter');
  keys &&= (await openAt(0)) && (await active()) === GUIDE_TOPICS[0];
  await page.keyboard.press('Space');
  keys &&= !(await openAt(0)) && (await active()) === GUIDE_TOPICS[0];
  for (let i = 1; i < GUIDE_TOPICS.length; i++) {
    await page.keyboard.press('Tab');
    keys &&= (await active()) === GUIDE_TOPICS[i];
    await page.keyboard.press('Space');
    keys &&= await openAt(i);
    await page.keyboard.press('Enter');
    keys &&= !(await openAt(i));
  }
  // 신청 안내: 꺼짐이면 준비 중·링크 0, 가상 켜짐이면 검수된 OfficialIntakeCta만(열지 않음)
  const applyIdx = GUIDE_TOPICS.indexOf('apply');
  await summaries.nth(applyIdx).click();
  const apply = await page.$eval('[data-guide-topic="apply"]', (d) => ({
    text: (d as HTMLElement).innerText, links: Array.from(d.querySelectorAll('a')).map((a) => a.getAttribute('href')),
  }));
  const applyOk = intakeOn
    ? apply.links.length === 2 && apply.links.every((h) => FAKE_HREFS.includes(h ?? '')) && !apply.text.includes('준비 중')
    : apply.links.length === 0 && apply.text.includes('준비 중');
  await summaries.nth(applyIdx).click();
  const text = await page.$eval('[data-product-guide]', (el) => (el as HTMLElement).innerText);
  const inputs = await page.$$eval('[data-product-guide] input, [data-product-guide] form, [data-product-guide] textarea, [data-product-guide] select, [data-product-guide] button, [data-product-guide] iframe, [data-product-guide] script, [data-product-guide] img', (n) => n.length);
  const same = page.url() === startUrl && !page.url().includes('#');
  const reqs = requests() - req0;
  return `\t상품안내 9주제=${nine}\t상품안내 처음 닫힘=${allClosed}\t상품안내 펼침·닫기 반복=${clicks}\t상품안내 키보드·초점=${keys}`
    + `\t상품안내 신청 안내=${applyOk}\t상품안내 보장·AI 표현 없음=${!GUARANTEE.test(text)}\t상품안내 주소 변화 없음=${same}\t상품안내 입력·외부요소=${inputs}\t상품안내 요청=${reqs}`;
}

const POLICY_FIXTURE: PolicyRow[] = [
  { id: '10000000-0000-4000-8000-000000000001', supplier_id: 'sample-supplier', segment: 'household', carrier: 'sample-carrier', product_id: 'sample-1', category: 'internet_tv', revision: 1, state: 'submitted', source_kind: 'official_policy_sheet', product_label: '인터넷+TV 샘플', confirmed_at: '2026-11-21T09:00:00+09:00', valid_from: '2026-11-21T00:00:00+09:00', valid_until: '2026-11-30T00:00:00+09:00', content_hash: 'ab12cd34ef56', self_approval: false, decided_at: null, decision_reason: null },
  { id: '10000000-0000-4000-8000-000000000002', supplier_id: 'sample-supplier', segment: 'household', carrier: 'sample-carrier', product_id: 'sample-2', category: 'internet_tv', revision: 2, state: 'approved', source_kind: 'distributor_notice', product_label: '인터넷+TV 샘플 B', confirmed_at: '2026-11-20T09:00:00+09:00', valid_from: '2026-11-20T00:00:00+09:00', valid_until: '2026-11-30T00:00:00+09:00', content_hash: '99aa88bb77cc', self_approval: false, decided_at: '2026-11-20T10:00:00+09:00', decision_reason: '정책표와 대조 완료' },
  { id: '10000000-0000-4000-8000-000000000003', supplier_id: 'sample-supplier', segment: 'household', carrier: 'sample-carrier', product_id: 'sample-3', category: 'internet_tv', revision: 1, state: 'draft', source_kind: 'training_material', product_label: '인터넷+TV 샘플 C', confirmed_at: '2026-11-19T09:00:00+09:00', valid_from: '2026-11-19T00:00:00+09:00', valid_until: '2026-11-30T00:00:00+09:00', content_hash: '1122334455aa', self_approval: false, decided_at: null, decision_reason: null },
];

const BUDGET_FIXTURE: BudgetRow[] = [
  { id: '10000000-0000-4000-8000-000000000001', campaign_key: 'sample-camp', state: 'active', daily_cap_krw: 10000, total_cap_krw: 30000, valid_until: '2026-11-23T09:00:00Z', reason: '시험 승인', created_at: '2026-11-21T09:00:00Z', revoke_reason: null, spent_today: 4000, spent_total: 4000 },
  { id: '10000000-0000-4000-8000-000000000002', campaign_key: 'old-camp', state: 'revoked', daily_cap_krw: 5000, total_cap_krw: 12000, valid_until: '2026-11-22T09:00:00Z', reason: '이전 승인', created_at: '2026-11-20T09:00:00Z', revoke_reason: '교체', spent_today: 0, spent_total: 5000 },
];

const OUT = process.argv[2] ?? 'test-results/screens';
// 검사 폭: 좁은 휴대폰(320)과 일반 휴대폰(390). 둘 다 통과해야 한다.
const WIDTHS = [320, 390] as const;

async function main() {
  const css = await readFile('src/app/globals.css', 'utf8');
  const pages: [string, ReactElement][] = [
    ['01-home', <Home key="home" />],
    ['02-internet-tv', <InternetTv key="internet-tv" />],
    ['05-consult', await Consult()],
    ['06-admin-login', <LoginPreview key="admin-login" />],
    ['07-admin-leads', <AdminMockView key="admin" />],
    ['08-admin-progress', <ProgressView key="progress" snapshot={PROGRESS_FIXTURE} now={new Date('2026-11-16T03:00:00+09:00')} />],
    // 로컬 시험용 읽기 전용 목록(가상 7키 DTO, 실제 데이터 아님)과 잠금 화면
    ['09-admin-read', <LeadsReadView key="read" items={READ_FIXTURE} actor={READ_ACTOR} offset={20} limit={2} headerExtra={<span className="admin-role">대표</span>} />],
    ['10-admin-read-locked', <LeadsReadLocked key="read-locked" kind="failed" />],
    // 관리자 정책 화면(가상 목록, 실제 정책 아님): 대표 / 정책 담당 / 잠금
    ['16-admin-policies-owner', <PolicyAdminView key="pol-owner" items={POLICY_FIXTURE} role="owner" publishOn={false} />],
    ['17-admin-policies-editor', <PolicyAdminView key="pol-editor" items={POLICY_FIXTURE} role="policy_editor" publishOn={false} />],
    ['18-admin-policies-locked', <PolicyLocked key="pol-locked" kind="disabled" />],
    // 광고 예산 화면(가상 내역, 실제 광고 집행 없음): 대표 / 검토자 / 잠금
    ['19-admin-ads-owner', <AdBudgetView key="ad-owner" items={BUDGET_FIXTURE} role="owner" caps={{ dailyKrw: 10000, totalKrw: 30000 }} />],
    ['20-admin-ads-reviewer', <AdBudgetView key="ad-rev" items={BUDGET_FIXTURE} role="reviewer" caps={{ dailyKrw: 10000, totalKrw: 30000 }} />],
    ['21-admin-ads-locked', <AdBudgetLocked key="ad-locked" kind="disabled" />],
    // 가상 등록부를 켠 표시(정상 경로 모양·모바일 넘침·개인정보 미전달 속성 확인용). 공개 화면 아님
    ['11-official-intake-fake', <PageShell key="intake-fake"><section className="hero"><h1>가상 공식 접수처 표시</h1><OfficialIntakeCta intake={FAKE_INTAKE} /></section></PageShell>],
    // 선택형 상품 안내 패널(실제 코드 상수는 false). 가상 켜짐 화면: 접수 꺼짐(12)과 가상 접수 켜짐(13). 공개 화면 아님
    ['12-product-guide-intake-off', <PageShell key="guide-off"><ProductGuidePanel intake={INTAKE_OFF} /></PageShell>],
    ['13-product-guide-intake-fake-on', <PageShell key="guide-on"><ProductGuidePanel intake={FAKE_INTAKE} /></PageShell>],
    // 카카오톡 상품 문의 가상 켜짐: 상담 폼 안내(14)와 인터넷TV 상세(15). 공개 화면 아님
    ['14-kakao-inquiry-consult-fake-on', <PageShell key="kakao-consult"><section className="section"><ConsultForm options={[{ value: 'internet_tv', label: '인터넷+TV' }]} kakaoUrl={FAKE_KAKAO.state === 'on' ? FAKE_KAKAO.href : null} /></section></PageShell>],
    ['15-kakao-inquiry-internet-tv-fake-on', <ProductPage key="kakao-tv" slug="internet-tv" inquiry={FAKE_KAKAO} />],
  ];
  const routeChecks = [
    expect404('03-internet-phone', () => <InternetPhone />),
    expect404('04-cctv-security', () => <Cctv />),
  ];
  // 상담 페이지는 주소의 ?interest= 값을 읽지 않는다(실제 주소 주입은 tests/e2e/mobile-real.ts 09번이 서버에서 확인).
  // 브라우저로 내려가는 폼 코드에 예약 상품 이름이 없는지는 tests/unit/catalog.test.ts G10이 확인한다.
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report: string[] = [];
  // 폭별로 따로 연다(320 결과를 390이 덮어쓰지 않도록 파일·라벨에 폭을 붙인다). 하나라도 실패하면 exit 1.
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const [name, el] of pages) {
      const label = `${name}@${width}`;
      const html = '<!doctype html>' + renderToStaticMarkup(<RootLayout>{el}</RootLayout>)
        .replace('<html lang="ko">', '<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head>');
      await writeFile(`${OUT}/${name}.html`, html);
      const page = await ctx.newPage();
      let requestCount = 0;
      page.on('request', () => { requestCount++; });
      await page.setContent(html, { waitUntil: 'load' });
      // 모바일 에뮬레이션(isMobile)에서는 내용이 넓으면 브라우저가 레이아웃 폭(innerWidth)까지 넓혀 버린다.
      // 그래서 innerWidth가 아니라 '설정한 화면 폭'과 비교한다(이전 검사는 이 때문에 넘침을 못 잡을 수 있었다).
      const overflow = await page.evaluate((w) => document.documentElement.scrollWidth > w || document.body.scrollWidth > w, width);
      const prices = await page.evaluate(() => (document.body.innerText.match(/[0-9][0-9,]*\s*원/g) ?? []).length);
      await page.screenshot({ path: `${OUT}/${name}-w${width}-first-view.png` });
      // 전체 페이지 캡처에서는 하단 고정 버튼이 중간에 겹치지 않도록 문서 끝에 둔다
      await page.addStyleTag({ content: '.sticky-cta{position:static}' });
      await page.screenshot({ path: `${OUT}/${name}-w${width}.png`, fullPage: true });
      // 검사는 <body>만 본다(인라인 CSS의 클래스 이름은 화면에 나오지 않으므로 제외)
      const body = html.slice(html.indexOf('<body'));
      const leaked = PUBLIC_PAGES.has(name) ? FORBIDDEN.filter((f) => body.includes(f)) : [];
      const kakaoFake = name.startsWith('14') || name.startsWith('15');
      // 가상 켜짐 화면(14·15)만 카카오 링크를 가진다. 나머지 화면은 기존대로 외부 상담 표식이 하나도 없어야 한다
      const ext = kakaoFake ? [] : EXTERNAL_CHANNEL.filter((f) => body.includes(f));
      const intake = PUBLIC_PAGES.has(name) ? INTAKE_PHRASES.filter((f) => body.includes(f)) : [];
      const notice = PUBLIC_PAGES.has(name) ? `\t준비 중 안내=${body.includes(NOTICE)}` : '';
      const fixed = name.startsWith('05')
        ? `\t상담 대상 고정=${html.includes('name="interest" value="internet_tv"') && !html.includes('<select name="interest"')}` : '';
      // 공식 접수처 연결: 기본(실제 설정) 화면에는 표식이 없어야 하고, 가상 화면은 고정 목적지·비전달 속성만 가져야 한다
      let intakeCheck = '';
      if (name.startsWith('11')) {
        const anchors = await page.evaluate(() => Array.from(document.querySelectorAll('[data-official-intake] a')).map((a) => ({
          href: a.getAttribute('href'), rel: a.getAttribute('rel'), rp: a.getAttribute('referrerpolicy'), target: a.getAttribute('target') })));
        const inputs = await page.evaluate(() => document.querySelectorAll('[data-official-intake] input, [data-official-intake] form, [data-official-intake] iframe, [data-official-intake] script, [data-official-intake] img').length);
        const okLinks = FAKE_INTAKE.state === 'on' && anchors.length === FAKE_HREFS.length
          && anchors.every((a, i) => a.href === FAKE_HREFS[i] && !/[?#]/.test(a.href ?? '') && /\bnoreferrer\b/.test(a.rel ?? '') && /\bnoopener\b/.test(a.rel ?? '') && a.rp === 'no-referrer' && a.target === '_blank');
        intakeCheck = `\t공식접수 가상 링크=${okLinks}\t공식접수 입력·외부요소=${inputs}`;
      } else if (!name.startsWith('13')) {
        intakeCheck = `\t공식접수 표식 없음=${!body.includes('data-official-intake')}`;
      }
      const inputCount = await page.evaluate(() => document.querySelectorAll('input, textarea, select').length);
      if (name.startsWith('05')) consultInputBaseline = inputCount;
      if (kakaoFake) {
        const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="kakao"]')).map((a) => ({
          href: a.getAttribute('href'), rel: a.getAttribute('rel'), rp: a.getAttribute('referrerpolicy'), target: a.getAttribute('target') })));
        const okLink = FAKE_KAKAO.state === 'on' && links.length === 1 && links[0]!.href === FAKE_KAKAO_HREF && !/[?#]/.test(links[0]!.href ?? '')
          && /\bnoopener\b/.test(links[0]!.rel ?? '') && /\bnoreferrer\b/.test(links[0]!.rel ?? '') && links[0]!.rp === 'no-referrer' && links[0]!.target === '_blank';
        const notes = KAKAO_INQUIRY_NOTES.every((n) => body.includes(n));
        const inputsOk = name.startsWith('14') ? consultInputBaseline >= 0 && inputCount === consultInputBaseline : inputCount === 0;
        const frames = await page.evaluate(() => document.querySelectorAll('iframe, script[src]').length);
        intakeCheck += `\t카톡문의 가상 링크=${okLink}\t카톡문의 안내=${notes}\t카톡문의 입력칸 추가 없음=${inputsOk}\t카톡문의 외부요소=${frames}\t카톡문의 요청=${requestCount}`;
      } else {
        // 관리자 가상 목록의 유입 출처 값('kakao' 글자)은 링크가 아니므로 링크·버튼·주소 표식만 본다
        intakeCheck += `\t카톡문의 표식 없음=${!['data-kakao-inquiry', 'btn-kakao', 'kakao.com', 'kakao-inquiry-note'].some((f) => body.includes(f))}`;
      }
      if (name.startsWith('12') || name.startsWith('13')) {
        intakeCheck += await guideInteraction(page, name.startsWith('13'), () => requestCount);
      } else {
        intakeCheck += `\t상품안내 표식 없음=${!body.includes('data-product-guide')}`;
      }
      report.push(`${label}\t가로 넘침=${overflow}\t금액 표기=${prices}\t예약 상품 노출=${leaked.length ? leaked.join(',') : '없음'}\t외부 상담 연결=${ext.length ? ext.join(',') : '없음'}\t접수 오해 문구=${intake.length ? intake.join(',') : '없음'}${notice}${fixed}${intakeCheck}`);
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
  report.push(...routeChecks);
  await writeFile(`${OUT}/checks.txt`, report.join('\n') + '\n');
  console.log(report.join('\n'));
  // 광고 예산 화면(19·20)의 금액은 상품 요금이 아니라 관리자 한도 숫자이므로 요금 노출 검사에서만 제외한다(나머지 검사는 동일).
  const bad = report.filter((r) =>
    r.includes('가로 넘침=true') || (/금액 표기=[1-9]/.test(r) && !/^(19|20)-admin-ads/.test(r)) || /예약 상품 노출=(?!없음)/.test(r) || /외부 상담 연결=(?!없음)/.test(r) || /접수 오해 문구=(?!없음)/.test(r) || /준비 중 안내=false/.test(r)
    || /(404|고정)=false/.test(r) || /공식접수 (가상 링크|표식 없음)=false/.test(r) || /공식접수 입력·외부요소=[1-9]/.test(r)
    || /상품안내 [^=\t]+=false/.test(r) || /상품안내 (입력·외부요소|요청)=[1-9]/.test(r)
    || /카톡문의 [^=\t]+=false/.test(r) || /카톡문의 (외부요소|요청)=[1-9]/.test(r));
  if (bad.length) {
    console.error('PREVIEW FAIL\n' + bad.join('\n'));
    process.exit(1);
  }
  // 정적 미리보기(위, test-results/screens)와 별도로, 빌드된 실제 Next 서버의 기본 비활성 경계를 실HTTP·RSC로 검사한다
  // (scripts/server-smoke/run.mjs, 결과 test-results/server-smoke). 빌드·next가 없으면 실패한다(CI에서는 건너뛰기 불가).
  const smoke = spawnSync(process.execPath, ['scripts/server-smoke/run.mjs'], { stdio: 'inherit', env: process.env });
  if (smoke.status !== 0) {
    console.error('SERVER SMOKE FAIL (exit ' + smoke.status + ')');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
