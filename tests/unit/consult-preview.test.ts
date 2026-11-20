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
  HOME_MOVING_AD_FLOW,
  AD_ENTRY_PICKS,
  AD_ENTRY_LABEL,
  COST_ROWS,
  isComplete,
  keyPoint,
  kstParts,
  MOCK_CALL_RESULT,
  MOCK_SATURDAY_HOURS_TEXT,
  phoneState,
  PHONE_VS_VISIT_NOTE,
  PRICE_TERM_TO_CHECK,
  INSTALL_TO_CHECK,
  GIFT_TO_CHECK,
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
        assert.ok(c.label && c.reply && c.general && (c.toCheck.length > 0 || c.id === 'moving'), `${step.id}/${c.id} 빈 값`);
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
  assert.ok(a.toCheck.includes(INSTALL_TO_CHECK) && !a.toCheck.includes('지금 쓰는 약정이 끝나는 시기와 해지 비용'));
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
  PHONE_VS_VISIT_NOTE,
  ...EXAMPLES.flatMap((e) => [e.title, e.ask, e.answer]),
  ...FAQ.flatMap((f) => [f.q, f.a]),
  ...PRIVACY_FAQ.flatMap((f) => [f.q, f.a]),
  ...SEGMENTS.flatMap((s) => [s.label, s.hint]),
  ...Object.values(FLOWS).flatMap((f) => [f.label, ...f.steps.flatMap((s) => [s.question, ...s.choices.flatMap((c) => [c.label, c.reply, c.general, ...c.toCheck])])]),
].join('\n');

const BANNED: [string, RegExp][] = [
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

const SUCCESS_DENIAL = '이 문의가 전달됐다고 말씀드릴 수는 없어요';

test('CP9 고정 문구에 가격·혜택·확정 약속·성공 표시·다른 상품·외부 채널이 없다', () => {
  // 승인된 정정 문구 안의 부정 표현("전달됐다고 말씀드릴 수는 없어요")은 성공 표시가 아니다
  const text = ALL_TEXT.replaceAll('이 문의가 전달됐다고 말씀드릴 수는 없어요', '');
  for (const [name, re] of BANNED) assert.ok(!re.test(text), `${name}: ${re.exec(text)?.[0]}`);
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
const DEMO_COMPONENT = readFileSync('src/components/ConsultHandoffDemo.tsx', 'utf8');
const PAGE = readFileSync('src/app/preview/consult-chat/page.tsx', 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('CP12 화면 코드: 입력칸·외부 전송·저장·분석·전화 링크가 없다', () => {
  const src = stripComments(COMPONENT + '\n' + DEMO_COMPONENT);
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

// ── PM 7014853871 / 7014881513: 개선 + '아직 잘 모르겠어요' ─────────────────────────────
const combos = (segment: 'home' | 'business'): string[][] => {
  const steps = FLOWS[segment].steps;
  let acc: string[][] = [[]];
  for (const st of steps) acc = acc.flatMap((a) => st.choices.map((c) => [...a, c.id]));
  return acc;
};

test('CP14 가정용 "아직 잘 모르겠어요": 더 비싼 속도를 권하지 않고 스스로 확인할 기준 하나를 제시', () => {
  const devices = FLOWS.home.steps[1].choices.find((c) => c.id === 'unsure');
  assert.ok(devices, '선택지 있음');
  assert.equal(devices.label, '아직 잘 모르겠어요');
  assert.match(devices.reply, /저녁에 영상회의와 TV 시청이 겹치는지부터 살펴보세요/);
  assert.ok(!/더 높은 속도(를)? (추천|고르세요|올리세요)|업그레이드/.test(devices.reply));
  const s = buildSummary('home', ['moving', 'unsure', 'sometimes']);
  assert.ok(s.conditions.includes('아직 잘 모르겠어요'));
  assert.equal(s.keyPoint.point, '저녁에 영상회의와 TV 시청이 겹치는지');
  assert.ok(s.toCheck.includes('저녁에 영상회의와 TV 시청이 겹치는지'));
  assert.ok(isComplete('home', ['moving', 'unsure', 'sometimes']));
});

test('CP15 요약은 매달 낼 비용과 설치 관련 비용을 나누고, 확인된 금액이 없으면 숫자를 채우지 않는다', () => {
  assert.deepEqual(COST_ROWS.map((c) => c.title), ['매달 낼 비용', '설치 관련 비용']);
  assert.match(COST_ROWS[0].items, /월 요금/);
  assert.match(COST_ROWS[0].items, /장비 임대료/);
  assert.equal(COST_ROWS[1].items, '설치비 금액과 청구 시점은 확인이 필요해요');
  for (const c of COST_ROWS) {
    assert.equal(c.status, '확인된 금액 없음');
    assert.ok(!/\d/.test(c.items + c.status), '숫자 없음');
  }
  for (const seg of ['home', 'business'] as const) for (const picks of combos(seg)) assert.deepEqual(buildSummary(seg, picks).costs, COST_ROWS);
});

test('CP16 사업장 "아직 정하지 못했어요" → 홀로 다시 고르면 새 요약에서 미정 상태가 사라진다', () => {
  const undecided = FLOWS.business.steps[1].choices.find((c) => c.id === 'undecided');
  assert.ok(undecided);
  assert.match(undecided.reply, /손님이 보는 홀인지 직원 휴게실인지 정해지면 이용 조건을 비교할 수 있어요/);
  const before = buildSummary('business', ['office', 'undecided']);
  assert.ok(before.conditions.includes('아직 정하지 못했어요'));
  assert.ok(before.toCheck.some((t) => t.includes('손님이 보는 홀인지 직원 휴게실인지')));
  assert.ok(before.general.some((t) => t.includes('TV 용도가 정해지지 않았다면')));
  assert.equal(before.keyPoint.point, 'TV를 둘 장소(손님이 보는 홀인지 직원 휴게실인지)');
  const after = buildSummary('business', ['office', 'guest']);
  assert.ok(!after.conditions.includes('아직 정하지 못했어요'));
  assert.ok(after.conditions.includes('손님이 보는 홀·객실에 둬요'));
  assert.ok(!after.toCheck.some((t) => t.includes('직원 휴게실인지')));
  assert.ok(!after.general.some((t) => t.includes('정해지지 않았다면')));
  assert.notEqual(after.keyPoint.point, before.keyPoint.point);
});

test('CP17 핵심 비교 포인트: 선택에 따라 달라지고, 이유가 있고, 금액·혜택·필요 상품을 단정하지 않는다', () => {
  const points = new Set<string>();
  const texts: string[] = [];
  for (const seg of ['home', 'business'] as const) {
    for (const picks of combos(seg)) {
      const k = keyPoint(seg, picks);
      assert.ok(k.point.length > 0 && k.reason.length > 0, `${seg}/${picks.join(',')}`);
      points.add(k.point);
      texts.push(k.point, k.reason);
      assert.deepEqual(buildSummary(seg, picks).keyPoint, k);
    }
  }
  assert.ok(points.size >= 6, `서로 다른 포인트 ${points.size}개`);
  // 지시문 예시: 결제 매장은 회선 중단 시 결제 영향과 예비 회선, 동시 사용+TV는 동시 사용과 셋톱박스 임대료
  assert.equal(keyPoint('business', ['payment', 'guest']).point, '회선이 끊겼을 때 결제 영향과 예비 회선 필요 여부');
  assert.equal(keyPoint('home', ['moving', 'many', 'daily']).point, '동시 사용과 셋톱박스 임대료');
  const text = texts.join('\n');
  for (const [name, re] of BANNED) assert.ok(!re.test(text), `${name}: ${re.exec(text)?.[0]}`);
  assert.ok(!/추천|가장 좋|반드시 필요|꼭 필요한 상품/.test(text));
});

test('CP18 모든 선택 조합의 요약 문구에도 가격·혜택·확정 약속·성공 표시가 없다', () => {
  const texts: string[] = [];
  for (const seg of ['home', 'business'] as const) {
    for (const picks of combos(seg)) {
      const s = buildSummary(seg, picks);
      texts.push(...s.conditions, ...s.general, ...s.toCheck, s.keyPoint.point, s.keyPoint.reason);
    }
  }
  const text = texts.join('\n').replaceAll(SUCCESS_DENIAL, '');
  for (const [name, re] of BANNED) assert.ok(!re.test(text), `${name}: ${re.exec(text)?.[0]}`);
});

// WCAG 대비(글자색 ↔ 배경색): 화면에 쓰는 어두운 글자색 조합이 일반 글자 기준 4.5:1 이상인지 CSS 토큰에서 읽어 확인
const CSS = readFileSync('src/app/globals.css', 'utf8');
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS);
  assert.ok(m, `--${name} 토큰`);
  return m[1];
};
const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('CP19 글자 대비 4.5:1 이상(검은 계열 글자) — 시안에서 쓰는 조합', () => {
  const ink = token('ink');
  const ink2 = token('ink-2');
  const paper = token('paper');
  const wash = token('wash');
  const soft = token('signal-soft');
  const pairs: [string, string, string][] = [
    ['ink/paper', ink, paper],
    ['ink/wash', ink, wash],
    ['ink-2/paper', ink2, paper],
    ['ink-2/wash', ink2, wash],
    ['ink-2/signal-soft', ink2, soft],
    ['ink/signal-soft', ink, soft],
    ['흰 글자/ink', '#ffffff', ink],
    ['#9a3412/paper', '#9a3412', paper],
    ['#9a3412/signal-soft', '#9a3412', soft],
  ];
  for (const [name, fg, bg] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${name} ${contrast(fg, bg).toFixed(2)}`);
  // 시안 규칙 안에서 옅은 글자색(--muted, --signal)을 글자에 쓰지 않는다
  const block = CSS.slice(CSS.indexOf('/* 모바일 웹 상담 비공개 시안'));
  assert.ok(!/color:\s*var\(--(muted|signal)\)/.test(block), '시안 글자색에 옅은 토큰 사용');
});

test('CP20 초점 이동·모션 축소·접힌 보조 영역이 화면 코드에 있다', () => {
  const src = stripComments(COMPONENT);
  assert.match(src, /tabIndex=\{-1\}/);
  assert.match(src, /\.focus\(\)/);
  assert.match(src, /focusTick/);
  assert.match(CSS, /@media \(prefers-reduced-motion: no-preference\)/);
  // 보조 FAQ·예시·개인정보는 접힌 상태(open 속성 없음)로 시작한다
  for (const aux of ['examples', 'faq', 'privacy']) {
    const m = new RegExp(`<details[^>]*data-aux="${aux}"[^>]*>`).exec(src);
    assert.ok(m, aux);
    assert.ok(!/\bopen\b/.test(m[0]), `${aux} 접힘`);
  }
});

// PM 7018202454: 광고(설치비·설치 가능 여부·희망 일정 장면) → 상담. 빠진 답이 기존 콘텐츠·접힌 도움말에 있는지
test('CP21 광고 설치 장면 질문의 답이 도움말에 있고, 금액·방문일 추정·성공 표시가 없다', () => {
  const find = (q: string) => FAQ.find((f) => f.q === q);
  const fee = find('설치비는 처음에 내나요?');
  const sat = find('이번 토요일 설치가 확정되나요?');
  const ok = find('우리 집이나 매장에 설치가 되는지 어떻게 알 수 있어요?');
  const visit = find('전화 상담이 되는 토요일이면 그날 설치도 되나요?');
  for (const f of [fee, sat, ok, visit]) assert.ok(f, '도움말 항목 누락');
  assert.ok(fee!.a.startsWith('설치비 금액과 청구 시점은 확인이 필요해요.') && fee!.a.includes('처음에 내는지는 지금 말씀드릴 수 없어요'));
  assert.ok(sat!.a.includes('아직 확정된 일정이 없어요') && sat!.a.includes('확정해 드릴 수 없어요'));
  assert.ok(ok!.a.includes('주소와 건물 조건') && ok!.a.includes('주소를 받지 않아서'));
  assert.ok(visit!.a.startsWith('전화 상담이 가능해도 설치 일정은 별도로 확인해야 해요.') && visit!.a.includes('전화로 상담할 수 있는 요일과 기사가 방문할 수 있는 날은 별개') && !visit!.a.startsWith('아니요'));
  assert.ok(PHONE_VS_VISIT_NOTE.includes('전화 상담이 가능한 시간과 기사가 방문할 수 있는 날은 달라요'));
  // 모든 요약에 설치 관련 비용(금액·청구 시점 확인 필요)과 설치 가능 여부·일정 확인 항목, 숫자 금액 없음
  for (const seg of ['home', 'business'] as const) {
    const picks = FLOWS[seg].steps.map((st) => st.choices[0].id);
    const sum = buildSummary(seg, picks);
    assert.ok(sum.toCheck.includes('설치 가능 여부, 희망 일정, 설치비 금액과 청구 시점'));
    assert.ok(sum.costs.some((c) => c.title === '설치 관련 비용' && c.items === '설치비 금액과 청구 시점은 확인이 필요해요' && c.status === '확인된 금액 없음'));
  }
});

// PM 7020185486: 설치비 안내 일관성 — 요약·FAQ·확인 항목이 같은 말(금액·청구 시점 확인 필요)을 하고, 분할 납부를 확인된 선택지처럼 쓰지 않는다
test('CP22 설치비 안내가 요약·FAQ·확인 항목에서 일관되고 분할 납부·"처음 낼 비용" 단정이 없다', () => {
  const text = ALL_TEXT;
  assert.ok(!/처음 (낼|내는|내요|내나)|설치비\(처음\)|한 번에 내는지|나눠 내|분할|할부/.test(text), '단정·분할 납부 표현 없음');
  const costRow = COST_ROWS.find((c) => c.title === '설치 관련 비용');
  assert.ok(costRow && costRow.items.includes('금액과 청구 시점'));
  const fee = FAQ.find((f) => f.q === '설치비는 처음에 내나요?');
  assert.ok(fee && fee.a.includes('금액과 청구 시점') && !/처음에 낸다|처음에 내요|처음 내요/.test(fee.a));
  assert.ok(COMMON_TO_CHECK.includes('설치 가능 여부, 희망 일정, 설치비 금액과 청구 시점'));
  // 토요일 설치 질문의 답은 "아니요"로 시작하지 않고 전화 상담 가능일과 설치 일정을 분리한다
  for (const q of ['이번 토요일 설치가 확정되나요?', '전화 상담이 되는 토요일이면 그날 설치도 되나요?']) {
    const f = FAQ.find((x) => x.q === q);
    assert.ok(f && !f.a.startsWith('아니요') && !/불가능|안 돼요|안돼요|설치할 수 없/.test(f.a), q);
  }
});

// PM 7020585092: 이사 분기 첫 줄(핵심 비교 포인트)도 설치비 청구 시점을 단정하지 않는다. 유효한 모든 최종 선택 조합의 buildSummary 결과를 검사한다
test('CP23 모든 최종 선택 조합의 요약(첫 줄 포함)에 "처음 내는 비용" 단정이 없고, 이사 경로는 금액·청구 시점 확인 안내가 보인다', () => {
  const STALE = /처음 (낼|내는|내요|내나)|한 번에 내|나눠 내|분할|할부/;
  let movingKey = 0;
  for (const seg of ['home', 'business'] as const) {
    for (const picks of combos(seg)) {
      assert.ok(isComplete(seg, picks));
      const sum = buildSummary(seg, picks);
      const whole = [sum.keyPoint.point, sum.keyPoint.reason, ...sum.conditions, ...sum.general, ...sum.toCheck, ...sum.costs.flatMap((c) => [c.title, c.items, c.status])].join('\n');
      assert.ok(!STALE.test(whole), `${seg} ${picks.join('>')}: ${STALE.exec(whole)?.[0]}`);
      if (seg === 'home' && picks[0] === 'moving' && sum.keyPoint.point === '설치 가능 여부와 설치비') {
        movingKey++;
        assert.equal(sum.keyPoint.reason, '새 주소의 건물 조건에 따라 설치 가능 여부가 달라져요. 설치비 금액과 청구 시점도 확인해 보세요.');
      }
    }
  }
  assert.ok(movingKey >= 5, `이사 첫 줄 조합 ${movingKey}개`);
  // 이사 대표 경로(moving → few → rare): 첫 줄·비용 구분·확인 항목에서 금액·청구 시점 확인 안내
  const rep = buildSummary('home', ['moving', 'few', 'rare']);
  assert.equal(rep.keyPoint.point, '설치 가능 여부와 설치비');
  assert.ok(rep.keyPoint.reason.includes('설치비 금액과 청구 시점도 확인해 보세요'));
  assert.ok(rep.costs.some((c) => c.title === '설치 관련 비용' && c.items.includes('금액과 청구 시점')));
  assert.ok(rep.toCheck.includes('설치 가능 여부, 희망 일정, 설치비 금액과 청구 시점'));
});

// PM 7021402686: 광고 나머지 비교 기준(사은품만 보고 고름 / 월 요금·약정 / 속도 모름)의 답이 상담 시안에 있고, 다음 확인 사항을 알려 주며, 사업장에 가정용 조건을 적용하지 않는다
test('CP24 광고 비교 기준 세 가지: 답 위치·다음 확인 사항, 가격·혜택 확정과 사업장 가정용 조건 적용 없음', () => {
  const gift = FAQ.find((f) => f.q === '사은품은 어디가 더 많아요?');
  assert.ok(gift && ['같은 약정 기간', '월 요금', '장비 비용', '설치비', '지급 조건'].every((k) => gift.a.includes(k)));
  const speed = FAQ.find((f) => f.q === '500메가면 충분해요?');
  assert.ok(speed);
  assert.ok(speed!.a.includes('저녁에 영상회의와 TV 시청이 겹치는지') && speed!.a.includes('바쁜 시간에 겹치는 작업과 장애 대응 조건'));
  assert.ok(!speed!.a.includes('위에서 고른'), '선택 전에도 읽히는 도움말에서 "위에서 고른 조건"을 가리키지 않는다');
  assert.ok(COMMON_TO_CHECK.includes('월 요금과 약정 기간(VAT 포함 여부 구분)'));
  assert.ok(COMMON_TO_CHECK.includes('장비 비용과 사은품 지급 조건(조건이 확인된 것만 비교)'));
  // 사업장 요약에는 가정용 조건(집·가정·우리 집)이 들어가지 않는다
  for (const picks of combos('business')) {
    const sum = buildSummary('business', picks);
    const whole = [sum.keyPoint.point, sum.keyPoint.reason, ...sum.conditions, ...sum.general, ...sum.toCheck].join('\n');
    assert.ok(!/가정|우리 집|집에서|저녁에 영상회의/.test(whole), `business ${picks.join('>')}: ${/가정|우리 집|집에서|저녁에 영상회의/.exec(whole)?.[0]}`);
  }
  // 속도를 모르는 가정용: 속도 추천이 아니라 겹침 확인이 다음 행동
  const u = buildSummary('home', ['moving', 'unsure', 'rare']);
  assert.equal(u.keyPoint.point, '저녁에 영상회의와 TV 시청이 겹치는지');
});

// PM 7024149005: 확인할 항목의 순서·중복·의미 보존
test('CP25 확인할 항목: 가정용은 월 요금·약정이 먼저, 설치 질문은 한 줄 한 번, 선택 조건·사업장 우선순위 보존, 중복 없음', () => {
  const INSTALL_WORDS = /설치 가능 여부|희망 일정|희망하는 설치 일정|설치비/;
  let n = 0;
  for (const seg of ['home', 'business'] as const) {
    const steps = FLOWS[seg].steps;
    for (const picks of combos(seg)) {
      n++;
      const { toCheck } = buildSummary(seg, picks);
      const tag = `${seg} ${picks.join('>')}`;
      assert.equal(new Set(toCheck).size, toCheck.length, `${tag}: 중복 줄`);
      // 설치 관련 질문은 정확히 한 줄(TV 설치 대수처럼 설치 가능 여부·희망 일정·설치비가 아닌 항목은 해당 없음)
      assert.equal(toCheck.filter((t) => INSTALL_WORDS.test(t)).length, 1, `${tag}: 설치 줄 수`);
      assert.ok(toCheck.includes(INSTALL_TO_CHECK) && toCheck.includes(GIFT_TO_CHECK) && toCheck.includes(PRICE_TERM_TO_CHECK));
      // 선택 항목(원래 의미) 보존: 각 선택의 toCheck가 순서대로 그대로 들어 있다
      const selected = steps.flatMap((st, i) => st.choices.find((c) => c.id === picks[i])!.toCheck).filter((t, i, a) => a.indexOf(t) === i);
      for (const t of selected) assert.ok(toCheck.includes(t), `${tag}: 선택 항목 누락 ${t}`);
      const idx = selected.map((t) => toCheck.indexOf(t));
      assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${tag}: 선택 항목 순서`);
      // 꼬리: 설치(한 줄) → 장비·사은품이 항상 마지막 두 줄
      assert.deepEqual(toCheck.slice(-2), [INSTALL_TO_CHECK, GIFT_TO_CHECK], tag);
      if (seg === 'home') {
        assert.equal(toCheck[0], PRICE_TERM_TO_CHECK, `${tag}: 월 요금·약정이 첫 줄`);
        assert.ok(idx.every((i) => i > 0));
      } else {
        // 사업장: 결제 중단·장애 대응 등 선택 항목이 월 요금 줄보다 앞
        assert.ok(idx.every((i) => i < toCheck.indexOf(PRICE_TERM_TO_CHECK)), `${tag}: 사업장 선택 항목 우선`);
      }
    }
  }
  assert.equal(n, 36);
  // 가정 이사 선택은 설치 항목을 따로 더하지 않는다(공통 한 줄이 맡는다)
  assert.deepEqual(FLOWS.home.steps[0].choices.find((c) => c.id === 'moving')!.toCheck, []);
  // 선택을 바꾸면 이전 조건이 사라진다: 1~2개 → 5개 이상
  const a = buildSummary('home', ['renewal', 'few', 'rare']).toCheck;
  const b = buildSummary('home', ['renewal', 'many', 'rare']).toCheck;
  assert.ok(a.includes('집에서 와이파이가 약한 방이 있는지') && !b.includes('집에서 와이파이가 약한 방이 있는지'));
  assert.ok(b.includes('공유기 구성(추가 장비 필요 여부)') && !a.includes('공유기 구성(추가 장비 필요 여부)'));
});

// PM 7029405014: 담당자 연결 모의 예시(검수한 판정 함수 재사용)
test('CP26 담당자 연결 모의 예시: 네 사례가 각각 하나의 안내, 모의 확인에만 "모의 결과 · 실제 문의 전송 없음" 표시, 고정 가상 값만 사용', async () => {
  const { DEMO_CASES, MOCK_BADGE, DEMO_NOTE, runDemoCase } = await import('../../src/content/consultHandoffDemo');
  const { REPLIES } = await import('../../src/content/consultHandoff');
  assert.deepEqual(DEMO_CASES.map((c) => c.id), ['off', 'unavailable', 'unknown', 'confirmed']);
  assert.deepEqual(DEMO_CASES.map((c) => c.label), ['경로 꺼짐', '연결 확인 불가', '전달 결과 불명', '모의 확인']);
  assert.equal(MOCK_BADGE, '모의 결과 · 실제 문의 전송 없음');
  assert.ok(DEMO_NOTE.includes('실제로 전송되지 않아요'));
  for (const c of DEMO_CASES) {
    const a = runDemoCase(c.id);
    assert.equal(a.state, c.expectState, c.id);
    assert.equal(a.text, REPLIES[c.expectState], c.id);
    assert.equal(a.mock, c.id === 'confirmed', c.id);
    assert.deepEqual(runDemoCase(c.id), a, '같은 사례는 항상 같은 결과');
    assert.ok(c.events.length > 10);
  }
  // 모의 확인 문구와 표시는 화면 코드에서 같은 문단 안에 붙어 있다
  assert.match(DEMO_COMPONENT, /\{result\.text\}\s*\n?\s*\{result\.mock \? <span className="cp-handoff-mock">\{MOCK_BADGE\}<\/span> : null\}/);
  const src = readFileSync('src/content/consultHandoffDemo.ts', 'utf8');
  assert.ok(!/fetch\(|process\.env|Date\.now|new Date|setTimeout|setInterval|Math\.random|localStorage/.test(src), '시계·난수·저장·전송 없음');
  // 일반 예시 영역 안에 접힌 상태로 들어 있다
  assert.match(COMPONENT, /<details className="cp-fold cp-handoff-fold" data-handoff-fold="">/);
  assert.ok(COMPONENT.indexOf('data-aux="examples"') < COMPONENT.indexOf('data-handoff-fold'));
  assert.ok(COMPONENT.indexOf('data-handoff-fold') < COMPONENT.indexOf('data-aux="faq"'));
  assert.ok(!/<details[^>]*cp-handoff-fold[^>]*\bopen\b/.test(COMPONENT));
  assert.ok(!/MOCK_BADGE|모의 결과/.test(COMPONENT), '배지 문구는 별도 컴포넌트·콘텐츠에서만');
});

test('CP27 광고 시안 → 이사 상담: 이사 선택 상태로 시작, 쓰는 인터넷 선택에 따라 요약이 바뀌고 일반 흐름은 그대로', () => {
  assert.equal(AD_ENTRY_LABEL, '이사 전 확인 목록 보기');
  assert.deepEqual([...AD_ENTRY_PICKS], ['moving']);
  assert.deepEqual(HOME_MOVING_AD_FLOW.steps.map((x) => x.id), ['reason', 'existing', 'devices', 'tv']);
  assert.deepEqual(FLOWS.home.steps.map((x) => x.id), ['reason', 'devices', 'tv'], '일반 상담 흐름은 바뀌지 않는다');
  const f = HOME_MOVING_AD_FLOW;
  assert.equal(isComplete('home', ['moving', 'has', 'some'], f), false);
  const has = buildSummary('home', ['moving', 'has', 'some', 'daily'], f);
  const none = buildSummary('home', ['moving', 'none', 'some', 'daily'], f);
  assert.ok(has.conditions.includes('지금 쓰는 인터넷이 있어요') && !has.conditions.includes('지금은 없어요'));
  assert.ok(none.conditions.includes('지금은 없어요') && !none.conditions.includes('지금 쓰는 인터넷이 있어요'));
  assert.ok(has.toCheck.some((t) => t.includes('이전·해지 조건')) && !none.toCheck.some((t) => t.includes('이전·해지 조건')));
  assert.notDeepEqual(has.general, none.general);
  // 핵심 비교점은 기본 흐름과 같은 규칙(쓰는 인터넷 답은 규칙 입력에서 뺀다)
  assert.deepEqual(has.keyPoint, keyPoint('home', ['moving', 'some', 'daily']));
  // 새 문구에 금액·확정·성공 표현 없음
  const all = JSON.stringify(f.steps[1]);
  assert.ok(!/\d[\d,]*\s*원|무료|할인|혜택|확정됩니다|확정돼요|접수|가입|예약|신청/.test(all));
  // 화면: 광고 카드는 시작 화면에서 버튼 하나로만 이어지고 전송·링크·입력이 없다
  assert.match(COMPONENT, /data-ad-draft="moving"/);
  assert.match(COMPONENT, /onClick=\{startFromAd\}/);
});
