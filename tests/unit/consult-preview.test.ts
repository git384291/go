// 모바일 웹 상담 비공개 시안(가상 대화) — 순수 판정·고정 문구·소스 점검(PM 7011892065). 외부 요청·저장 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AI_NOTICE,
  buildSummary,
  COMMON_TO_CHECK,
  EXAMPLES,
  FAQ,
  FLOWS,
  isComplete,
  kstParts,
  MOCK_CALL_RESULT,
  MOCK_SATURDAY_HOURS_TEXT,
  phoneState,
  PRIVACY_FAQ,
  SEGMENTS,
  VIRTUAL_NOTICE,
} from '../../src/content/consultPreview';

// 2026-11-20 금, 11-21 토, 11-22 일, 11-23 월 (한국 시간 기준 시각을 +09:00으로 적는다)
const at = (s: string) => new Date(`${s}+09:00`);
const kind = (s: string) => phoneState(at(s)).kind;

test('CP1 전화 안내: 평일은 숨김', () => {
  for (const s of ['2026-11-20T00:00:00', '2026-11-20T12:00:00', '2026-11-20T23:59:59', '2026-11-23T00:00:00', '2026-11-19T11:00:00']) {
    assert.equal(kind(s), 'hidden', s);
  }
});

test('CP2 토요일 가상 영업시간 경계: 10:00 포함, 16:00 제외', () => {
  assert.equal(kind('2026-11-21T00:00:00'), 'saturday_closed');
  assert.equal(kind('2026-11-21T09:59:59'), 'saturday_closed');
  assert.equal(kind('2026-11-21T10:00:00'), 'mock_open');
  assert.equal(kind('2026-11-21T15:59:59'), 'mock_open');
  assert.equal(kind('2026-11-21T16:00:00'), 'saturday_closed');
  assert.equal(kind('2026-11-21T23:59:59'), 'saturday_closed');
});

test('CP3 일요일은 토요일 운영 안내만(버튼 없음), 월요일 0시에 다시 숨김', () => {
  assert.equal(kind('2026-11-22T00:00:00'), 'sunday_notice');
  assert.equal(kind('2026-11-22T12:00:00'), 'sunday_notice');
  assert.equal(kind('2026-11-22T23:59:59'), 'sunday_notice');
  assert.equal(kind('2026-11-23T00:00:00'), 'hidden');
});

test('CP4 시간대: 컴퓨터 시간대와 무관하게 한국 시간으로 판단(UTC 표기 경계)', () => {
  // 금요일 15:00 UTC = 토요일 00:00 KST
  assert.equal(phoneState(new Date('2026-11-20T14:59:59Z')).kind, 'hidden');
  assert.equal(phoneState(new Date('2026-11-20T15:00:00Z')).kind, 'saturday_closed');
  // 토요일 01:00 UTC = 토요일 10:00 KST
  assert.equal(phoneState(new Date('2026-11-21T00:59:59Z')).kind, 'saturday_closed');
  assert.equal(phoneState(new Date('2026-11-21T01:00:00Z')).kind, 'mock_open');
  // 토요일 15:00 UTC = 일요일 00:00 KST
  assert.equal(phoneState(new Date('2026-11-21T15:00:00Z')).kind, 'sunday_notice');
  assert.deepEqual(kstParts(new Date('2026-11-21T15:00:00Z')), { day: 0, minutes: 0 });
});

test('CP5 잘못된 시각은 숨김(전화 안내를 잘못 켜지 않는다)', () => {
  assert.equal(phoneState(new Date(Number.NaN)).kind, 'hidden');
  assert.equal(kstParts(new Date(Number.NaN)), null);
});

test('CP6 흐름 구조: 두 선택, 한 질문씩, 선택지 id 중복 없음', () => {
  assert.deepEqual(SEGMENTS.map((s) => s.id), ['home', 'business']);
  assert.deepEqual(FLOWS.home.steps.map((s) => s.id), ['reason', 'devices', 'tv']);
  assert.deepEqual(FLOWS.business.steps.map((s) => s.id), ['work', 'tvuse']);
  for (const flow of Object.values(FLOWS)) {
    for (const step of flow.steps) {
      assert.ok(step.question.endsWith('?'), step.question);
      assert.ok(step.choices.length >= 2, step.id);
      const ids = step.choices.map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, `${step.id} id 중복`);
      for (const c of step.choices) {
        assert.ok(c.label && c.reply && c.general && c.toCheck.length > 0, `${step.id}/${c.id} 빈 값`);
      }
    }
  }
});

test('CP7 요약: 선택 조건·일반 안내·확인 항목이 선택에 맞춰 만들어지고, 고치면 바뀐다', () => {
  const a = buildSummary('home', ['moving', 'many', 'daily']);
  const b = buildSummary('home', ['renewal', 'many', 'daily']);
  assert.equal(a.conditions[0], '가정용 인터넷·TV');
  assert.ok(a.conditions.includes('이사해서 새로 알아봐요'));
  assert.ok(!a.conditions.includes('쓰던 약정이 끝나서 비교해요'));
  assert.ok(b.conditions.includes('쓰던 약정이 끝나서 비교해요'));
  assert.notDeepEqual(a.toCheck, b.toCheck);
  assert.ok(a.toCheck.includes('설치 가능 여부와 설치비'));
  assert.ok(b.toCheck.includes('지금 쓰는 약정이 끝나는 시기와 해지 비용'));
  for (const t of COMMON_TO_CHECK) assert.ok(a.toCheck.includes(t) && b.toCheck.includes(t));
  assert.equal(new Set(a.toCheck).size, a.toCheck.length, '확인 항목 중복 없음');
});

test('CP8 일부만 고른 상태·모르는 값은 완료가 아니고 요약에 섞이지 않는다', () => {
  assert.equal(isComplete('home', []), false);
  assert.equal(isComplete('home', ['moving', 'few']), false);
  assert.equal(isComplete('home', ['moving', 'few', 'rare']), true);
  assert.equal(isComplete('home', ['moving', 'few', 'nope']), false);
  assert.equal(isComplete('business', ['payment', 'guest']), true);
  // 다른 용도의 선택 id는 인정하지 않는다
  assert.equal(isComplete('business', ['moving', 'few']), false);
  const s = buildSummary('business', ['payment', 'nope']);
  assert.deepEqual(s.conditions, ['매장·사무실용 인터넷·TV', '카드 결제·배달 주문이 멈추는 거예요']);
});

const ALL_TEXT = [
  AI_NOTICE,
  VIRTUAL_NOTICE,
  MOCK_CALL_RESULT,
  MOCK_SATURDAY_HOURS_TEXT,
  ...COMMON_TO_CHECK,
  ...EXAMPLES.flatMap((e) => [e.title, e.ask, e.answer]),
  ...FAQ.flatMap((f) => [f.q, f.a]),
  ...PRIVACY_FAQ.flatMap((f) => [f.q, f.a]),
  ...SEGMENTS.flatMap((s) => [s.label, s.hint]),
  ...Object.values(FLOWS).flatMap((f) => [f.label, ...f.steps.flatMap((s) => [s.question, ...s.choices.flatMap((c) => [c.label, c.reply, c.general, ...c.toCheck])])]),
].join('\n');

test('CP9 고정 문구에 가격·혜택·확정 약속·성공 표시·다른 상품·외부 채널이 없다', () => {
  // 승인된 정정 문구 안의 부정 표현("전달됐다고 말씀드릴 수는 없어요")은 성공 표시가 아니다
  const text = ALL_TEXT.replaceAll('이 문의가 전달됐다고 말씀드릴 수는 없어요', '');
  const banned: [string, RegExp][] = [
    ['금액(원)', /\d[\d,]*\s*(원|만원)/],
    ['퍼센트', /%/],
    ['할인·무료·혜택 약속', /할인|무료|공짜|현금|최저가|혜택|지원금|페이백/],
    ['보장·확정 약속', /보장|무조건|당일 개통|확정됩니다|확정돼요/],
    ['카운트다운·마감', /마감|카운트|오늘만|선착순/],
    ['성공 표시', /(접수|가입|예약|신청|연결)\s*(됐|되었|완료|성공)|전달\s*(됐|되었|완료)|수신\s*(됐|확인했)/],
    ['주소·링크·전화', /https?:|tel:|www\.|0\d{1,2}-\d{3,4}-\d{4}/],
    ['외부 채널', /카카오|네이버|ARS/],
    ['다른 상품', /휴대폰|CCTV|집전화|동판|mobile/i],
    ['후기·실적', /후기|리뷰|만족도|가입자 수|누적/],
  ];
  for (const [name, re] of banned) assert.ok(!re.test(text), `${name}: ${re.exec(text)?.[0]}`);
});

test('CP10 승인된 두 상담 예시는 PR에서 승인한 문구 그대로다', () => {
  assert.equal(EXAMPLES.length, 2);
  assert.equal(EXAMPLES[0].answer, '설치비는 상품과 설치 조건에 따라 달라요. 토요일 설치도 가능 여부를 확인해야 해요. 지금은 금액이나 일정을 확정해 드릴 수 없어요.');
  assert.ok(EXAMPLES[1].answer.startsWith('현재 담당자 연결을 확인할 수 없어요.'));
  assert.ok(!EXAMPLES[1].answer.includes('자리에 없'), '정정 전 문구 아님');
});

test('CP11 AI 도우미·가상 대화 표시와 개인정보 FAQ가 구체적이다', () => {
  assert.match(AI_NOTICE, /AI 도우미/);
  assert.match(VIRTUAL_NOTICE, /가상 대화/);
  assert.match(VIRTUAL_NOTICE, /저장은 하지 않고/);
  const joined = PRIVACY_FAQ.map((f) => f.a).join(' ');
  for (const w of ['실명', '전화번호', '주소', '주민등록번호', '신분증', '계좌']) assert.ok(joined.includes(w), w);
  assert.match(joined, /처리하는 곳/);
  assert.match(joined, /보관 기간/);
});

const COMPONENT = readFileSync('src/components/ConsultPreviewChat.tsx', 'utf8');
const PAGE = readFileSync('src/app/preview/consult-chat/page.tsx', 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('CP12 화면 코드: 입력칸·외부 전송·저장·분석·전화 링크가 없다', () => {
  const src = stripComments(COMPONENT);
  for (const re of [/<input/i, /<textarea/i, /<select/i, /contentEditable/i, /\bfetch\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /tel:/, /href=/, /<form/i, /<a\s/i, /process\.env/, /gtag|dataLayer|analytics|pixel/i]) {
    assert.ok(!re.test(src), String(re));
  }
  assert.ok(/'use client'/.test(COMPONENT.split('\n')[0]));
  // 브라우저로 내려가는 코드: 상품 목록 모듈과 서버 모듈을 불러오지 않는다
  assert.ok(!/from '(@\/content\/(catalog|products)|\.\.\/content\/(catalog|products)|@\/server)/.test(src));
});

test('CP13 비공개 경로: 서버 환경값이 정확히 true일 때만, 검색 제외, 메뉴·sitemap·공통 화면에 없음', () => {
  assert.match(PAGE, /process\.env\.CONSULT_PREVIEW_ENABLED !== 'true'/);
  assert.match(PAGE, /notFound\(\)/);
  assert.ok(!/NEXT_PUBLIC_CONSULT_PREVIEW/.test(PAGE + COMPONENT));
  assert.match(PAGE, /index: false, follow: false/);
  for (const f of ['src/content/seo.ts', 'src/components/Site.tsx', 'src/app/robots.ts', 'src/app/sitemap.ts', 'src/app/page.tsx', 'src/content/products.ts']) {
    assert.ok(!readFileSync(f, 'utf8').includes('consult-chat'), `${f}에 비공개 경로가 나옴`);
  }
  assert.ok(!/vercel|CONSULT_PREVIEW_ENABLED/.test(readFileSync('vercel.json', 'utf8')), 'vercel.json에서 켜지 않음');
});
