/**
 * 모바일 웹 상담 비공개 시안(가상 대화) — 고정 문구·흐름·판정(순수 함수).
 *
 * PM 7011892065 범위: 비공개 시안. 아래를 하지 않는다.
 * - 실제 AI 호출·외부 전송·저장·분석 로그 없음. 자유 입력칸 없음(실명·전화·주소·주민번호·신분증·계좌 모두).
 * - 실제 전화·예약·메시지 없음. 전화 번호·tel: 링크 없음(모의 버튼만).
 * - 가격·혜택·실적·후기·카운트다운·보상 약속 없음. 설치비·일정 확정 금지, 접수·수신·가입 성공 표시 금지.
 * - 현재 활성 상품은 인터넷+TV 하나다. 다른 상품 이름은 이 파일에 두지 않는다.
 */

export type Segment = 'home' | 'business';

export type Choice = {
  readonly id: string;
  readonly label: string;
  /** 이 선택에 대한 AI 도우미의 짧은 답(일반 안내만, 확정 약속 없음) */
  readonly reply: string;
  /** 요약의 '확인된 일반 안내'에 들어가는 한 줄 */
  readonly general: string;
  /** 요약의 '확인할 항목'에 들어가는 한 줄들 */
  readonly toCheck: readonly string[];
};

export type Step = {
  readonly id: string;
  readonly question: string;
  readonly choices: readonly Choice[];
};

export type Flow = {
  readonly segment: Segment;
  readonly label: string;
  readonly steps: readonly Step[];
};

export const AI_NOTICE = 'AI 도우미가 안내하는 화면이에요. 사람 상담원이 아닙니다.';
export const VIRTUAL_NOTICE = '지금은 가상 대화 시안이에요. 실제 AI 호출·접수·연락·저장은 하지 않고, 선택한 내용은 이 화면을 닫으면 사라져요.';

export const SEGMENT_QUESTION = '집에서 쓰실 건가요, 매장이나 사무실에서 쓰실 건가요?';
export const SEGMENTS: readonly { readonly id: Segment; readonly label: string; readonly hint: string }[] = [
  { id: 'home', label: '가정용', hint: '집 인터넷·TV' },
  { id: 'business', label: '매장·사무실용', hint: '가게·사무실 인터넷·TV' },
];

const HOME_FLOW: Flow = {
  segment: 'home',
  label: '가정용',
  steps: [
    {
      id: 'reason',
      question: '지금 어떤 이유로 알아보세요?',
      choices: [
        {
          id: 'moving',
          label: '이사해서 새로 알아봐요',
          reply: '이사를 앞두고 계시군요. 설치 가능 여부와 설치비, 원하는 날짜는 주소와 건물 조건을 확인해야 알 수 있어요. 지금은 금액이나 일정을 확정해 드릴 수 없어요.',
          general: '이사라면 설치 가능 여부·설치비·희망 일정은 건물과 설치 조건에 따라 달라져요.',
          toCheck: ['설치 가능 여부와 설치비', '희망하는 설치 일정'],
        },
        {
          id: 'renewal',
          label: '쓰던 약정이 끝나서 비교해요',
          reply: '약정이 끝나서 비교 중이시군요. 지금 쓰는 조건을 끝낼 때 드는 비용과 새로 시작할 때의 조건을 같은 약정 기간으로 놓고 나란히 보면 실제 부담이 보여요.',
          general: '약정 만료 비교는 같은 약정 기간으로 놓고 월 요금·장비 비용·설치비를 나란히 봐야 해요.',
          toCheck: ['지금 쓰는 약정이 끝나는 시기와 해지 비용', '새 약정 기간과 월 요금'],
        },
      ],
    },
    {
      id: 'devices',
      question: '저녁에 동시에 쓰는 기기는 대략 몇 개예요?',
      choices: [
        {
          id: 'few',
          label: '1~2개',
          reply: '동시에 쓰는 기기가 많지 않다면, 필요 이상으로 높은 속도를 고르기보다 집 구조와 쓰는 방식부터 보면 돼요.',
          general: '동시 사용 기기가 적으면 가장 높은 속도부터 고를 필요는 없어요.',
          toCheck: ['집에서 와이파이가 약한 방이 있는지'],
        },
        {
          id: 'some',
          label: '3~4개',
          reply: '가족이 함께 쓰는 집이 많은 구간이에요. 영상을 보면서 다른 방에서 화상회의를 하는지처럼 겹치는 사용을 알려 주시면 구성을 좁힐 수 있어요.',
          general: '동시에 쓰는 기기가 늘수록 속도와 함께 공유기 성능·위치도 영향을 줘요.',
          toCheck: ['동시에 겹치는 사용(영상 시청·화상회의·게임)', '공유기 위치와 성능'],
        },
        {
          id: 'many',
          label: '5개 이상',
          reply: '기기가 많은 집이군요. 속도만 올리기보다 공유기 구성과 집 구조를 함께 확인하는 편이 정확해요.',
          general: '기기가 많으면 속도뿐 아니라 공유기 구성과 집 구조도 함께 확인해야 해요.',
          toCheck: ['공유기 구성(추가 장비 필요 여부)', '집 구조와 방 개수'],
        },
        {
          id: 'unsure',
          label: '아직 잘 모르겠어요',
          reply: '아직 모르셔도 괜찮아요. 더 비싼 속도부터 고르지 않아도 돼요. 먼저 저녁에 영상회의와 TV 시청이 겹치는지부터 살펴보세요. 겹친다면 동시 사용을 기준으로, 겹치지 않는다면 기본 구성부터 비교할 수 있어요.',
          general: '필요한 속도를 아직 모르면 더 높은 속도를 정하지 말고, 저녁에 영상회의와 TV 시청이 겹치는지 먼저 확인해 보세요.',
          toCheck: ['저녁에 영상회의와 TV 시청이 겹치는지'],
        },
      ],
    },
    {
      id: 'tv',
      question: 'TV는 얼마나 보세요?',
      choices: [
        {
          id: 'rare',
          label: '거의 안 봐요',
          reply: 'TV를 거의 안 보신다면 인터넷 중심으로 먼저 보고, TV 구성은 필요한 만큼만 확인하면 돼요.',
          general: 'TV 이용이 적으면 인터넷 조건을 먼저 보고 TV 구성은 최소로 확인해요.',
          toCheck: ['TV가 꼭 필요한지 여부'],
        },
        {
          id: 'sometimes',
          label: '가끔 봐요',
          reply: '가끔 보시는 정도라면 TV 이용료와 셋톱박스 비용이 월 부담에서 얼마나 차지하는지 나눠서 보는 게 좋아요.',
          general: 'TV 이용료와 셋톱박스 비용은 따로 구분해서 봐야 월 부담이 정확해요.',
          toCheck: ['TV 이용료와 셋톱박스 비용'],
        },
        {
          id: 'daily',
          label: '매일 봐요, 꼭 보는 채널이 있어요',
          reply: '매일 보시고 꼭 보는 채널이 있다면, 그 채널이 들어 있는 구성인지부터 확인하는 게 우선이에요.',
          general: '꼭 보는 채널이 있다면 그 채널이 포함된 TV 구성인지 먼저 확인해야 해요.',
          toCheck: ['꼭 보는 채널이 구성에 들어 있는지', 'TV 이용료와 셋톱박스 비용'],
        },
      ],
    },
  ],
};

const BUSINESS_FLOW: Flow = {
  segment: 'business',
  label: '매장·사무실용',
  steps: [
    {
      id: 'work',
      question: '인터넷이 끊기면 가장 곤란한 일이 뭐예요?',
      choices: [
        {
          id: 'payment',
          label: '카드 결제·배달 주문이 멈추는 거예요',
          reply: '결제나 주문이 멈추면 바로 영업에 지장이 있죠. 기본 구성으로 충분한지, 끊겼을 때를 대비한 예비 구성까지 볼지 나눠서 비교할 수 있어요.',
          general: '결제·주문이 중요하면 기본 구성과 예비 구성을 나눠 비교하고 장애 대응 조건도 같이 봐요.',
          toCheck: ['결제·주문 장비 종류와 개수', '장애가 났을 때 대응 조건'],
        },
        {
          id: 'office',
          label: '업무와 화상회의가 멈추는 거예요',
          reply: '직원 수보다 바쁜 시간에 어떤 작업이 겹치는지가 중요해요. 화상회의와 큰 파일 전송이 같이 일어나는지 확인하면 구성을 좁힐 수 있어요.',
          general: '업무용은 직원 수보다 바쁜 시간에 겹치는 작업(화상회의·파일 전송)이 기준이에요.',
          toCheck: ['동시에 접속하는 기기 수', '특정 주소에서만 접속되는 거래처 시스템이 있는지'],
        },
        {
          id: 'both',
          label: '둘 다 중요해요',
          reply: '결제와 업무가 모두 중요하다면 기본 구성과 끊김에 대비한 구성을 나눠서 월 비용, 설치 비용, 장애 대응 조건을 각각 비교해 보는 게 좋아요.',
          general: '결제와 업무가 모두 중요하면 기본 구성과 대비 구성을 나눠 비용과 장애 대응을 비교해요.',
          toCheck: ['결제·주문 장비와 업무 기기 수', '장애가 났을 때 대응 조건'],
        },
      ],
    },
    {
      id: 'tvuse',
      question: 'TV는 어디에서 쓰세요?',
      choices: [
        {
          id: 'staff',
          label: '직원 휴게실에서만 써요',
          reply: '직원이 보는 용도라면 설치 대수와 꼭 필요한 채널을 기준으로 이용할 수 있는 구성을 확인하면 돼요.',
          general: '직원용 TV는 설치 대수와 필요한 채널을 기준으로 구성을 확인해요.',
          toCheck: ['TV 설치 대수', '꼭 필요한 채널'],
        },
        {
          id: 'guest',
          label: '손님이 보는 홀·객실에 둬요',
          reply: '손님이 보는 곳이라면 해당 장소에서 이용할 수 있는 상품인지부터 확인해야 해요. 객실마다 따로 보시는지에 따라 확인할 조건이 달라져요.',
          general: '손님이 보는 장소의 TV는 그 장소에서 이용할 수 있는 상품인지 먼저 확인해야 해요.',
          toCheck: ['해당 장소에서 이용 가능한 상품인지', '객실 수와 TV 설치 대수'],
        },
        {
          id: 'none',
          label: 'TV는 필요 없어요',
          reply: 'TV가 필요 없다면 인터넷과 장애 대응 조건 중심으로 보면 돼요.',
          general: 'TV가 필요 없다면 인터넷과 장애 대응 조건 중심으로 비교해요.',
          toCheck: ['TV 없이 인터넷만 이용할 수 있는지'],
        },
        {
          id: 'undecided',
          label: '아직 정하지 못했어요',
          reply: '손님이 보는 홀인지 직원 휴게실인지 정해지면 이용 조건을 비교할 수 있어요. 정해지기 전에는 TV는 잠시 미뤄 두고 인터넷 조건부터 비교해도 돼요.',
          general: 'TV 용도가 정해지지 않았다면 인터넷 조건부터 비교하고, 용도가 정해지면 TV 이용 조건을 비교해요.',
          toCheck: ['TV를 둘 장소(손님이 보는 홀인지 직원 휴게실인지)'],
        },
      ],
    },
  ],
};

export const FLOWS: Readonly<Record<Segment, Flow>> = { home: HOME_FLOW, business: BUSINESS_FLOW };

/** 어떤 선택에서도 마지막 요약에 들어가는 확인 항목(가격·혜택을 말하지 않는다) */
export const COMMON_TO_CHECK: readonly string[] = [
  '월 요금과 약정 기간(VAT 포함 여부 구분)',
  '설치비와 설치 가능 여부, 희망 일정',
  '설치비 금액과 청구 시점',
  '장비 비용과 사은품 지급 조건(조건이 확인된 것만 비교)',
];

export type KeyPoint = { readonly point: string; readonly reason: string };

export type CostRow = { readonly title: string; readonly items: string; readonly status: string };

/** 매달 내는 비용과 처음 내는 비용을 나눠 보여 준다. 확인된 금액이 없으므로 숫자를 채우지 않는다 */
export const COST_ROWS: readonly CostRow[] = [
  { title: '매달 낼 비용', items: '월 요금 · 장비 임대료(셋톱박스 등)', status: '확인된 금액 없음' },
  { title: '설치 관련 비용', items: '설치비 금액과 청구 시점은 확인이 필요해요', status: '확인된 금액 없음' },
];

export type Summary = {
  readonly keyPoint: KeyPoint;
  readonly conditions: readonly string[];
  readonly general: readonly string[];
  readonly toCheck: readonly string[];
  readonly costs: readonly CostRow[];
};

/**
 * 선택에 따라 달라지는 '가장 먼저 비교할 점' 하나와 이유. 요금·혜택·필요한 상품을 단정하지 않는다.
 * 위에서부터 처음 맞는 규칙을 쓴다(순서가 곧 우선순위).
 */
export function keyPoint(segment: Segment, picks: readonly string[]): KeyPoint {
  if (segment === 'home') {
    const [reason, devices, tv] = picks;
    if (devices === 'unsure') {
      return { point: '저녁에 영상회의와 TV 시청이 겹치는지', reason: '필요한 속도를 아직 모르면 더 높은 속도부터 고르기보다, 가장 많이 겹치는 사용 하나를 먼저 확인하는 게 기준이 돼요.' };
    }
    if ((devices === 'some' || devices === 'many') && (tv === 'sometimes' || tv === 'daily')) {
      return { point: '동시 사용과 셋톱박스 임대료', reason: '여러 기기를 함께 쓰고 TV도 보신다면, 속도 하나보다 동시에 겹치는 사용과 셋톱박스 비용이 월 부담에 영향을 줘요.' };
    }
    if (reason === 'moving') {
      return { point: '설치 가능 여부와 설치비', reason: '이사는 새 주소의 건물 조건에 따라 설치 가능 여부와 처음 내는 비용이 달라질 수 있어요.' };
    }
    if (reason === 'renewal') {
      return { point: '지금 약정의 해지 비용과 새 약정 조건', reason: '약정 만료 비교는 같은 약정 기간으로 놓고 비교해야 실제 부담이 보여요.' };
    }
    return { point: '월 요금과 약정 기간', reason: '같은 약정 기간으로 놓고 월 요금과 장비 비용을 함께 봐야 해요.' };
  }
  const [work, tvuse] = picks;
  if (work === 'payment' || work === 'both') {
    return { point: '회선이 끊겼을 때 결제 영향과 예비 회선 필요 여부', reason: '결제·주문이 멈추면 영업에 바로 지장이 있어서, 기본 구성과 끊김에 대비한 구성을 나눠 비교하는 게 기준이 돼요.' };
  }
  if (tvuse === 'undecided') {
    return { point: 'TV를 둘 장소(손님이 보는 홀인지 직원 휴게실인지)', reason: '장소가 정해지면 그 장소에서 이용할 수 있는 조건을 비교할 수 있어요.' };
  }
  if (work === 'office') {
    return { point: '바쁜 시간에 겹치는 작업과 장애 대응 조건', reason: '업무용은 직원 수보다 화상회의·파일 전송처럼 동시에 겹치는 작업이 구성을 좌우해요.' };
  }
  return { point: '월 비용과 장애 대응 조건', reason: '사업장은 월 비용과 함께 끊겼을 때의 대응 조건을 같이 봐야 해요.' };
}

/** 선택한 값으로만 만든다. 모르는 값·범위를 벗어난 값은 무시한다(이전 선택을 고치면 다시 계산) */
export function buildSummary(segment: Segment, picks: readonly string[]): Summary {
  const flow = FLOWS[segment];
  const conditions: string[] = [`${flow.label} 인터넷·TV`];
  const general: string[] = [];
  const toCheck: string[] = [];
  flow.steps.forEach((step, i) => {
    const id = picks[i];
    const choice = step.choices.find((c) => c.id === id);
    if (!choice) return;
    conditions.push(choice.label);
    general.push(choice.general);
    for (const t of choice.toCheck) if (!toCheck.includes(t)) toCheck.push(t);
  });
  for (const t of COMMON_TO_CHECK) if (!toCheck.includes(t)) toCheck.push(t);
  return { keyPoint: keyPoint(segment, picks), conditions, general, toCheck, costs: COST_ROWS };
}

/** 선택이 모두 끝났는지(요약을 보여 줄 수 있는지) */
export function isComplete(segment: Segment, picks: readonly string[]): boolean {
  const flow = FLOWS[segment];
  return flow.steps.every((step, i) => step.choices.some((c) => c.id === picks[i]));
}

// ── 전화 안내(모의) ─────────────────────────────────────────────
// 실제 토요일 운영 시간·전화번호는 미정이다. 아래 시간은 화면 시험용 '가상' 값이며 실제 운영 시간이 아니다.
export const MOCK_SATURDAY_OPEN_MIN = 10 * 60;
export const MOCK_SATURDAY_CLOSE_MIN = 16 * 60; // 끝 시각은 포함하지 않는다(15:59까지 열림)
export const MOCK_SATURDAY_HOURS_TEXT = '토요일 10:00~16:00(가상 시간, 실제 운영 시간은 미정)';

export type PhoneState =
  | { readonly kind: 'hidden' } // 평일: 전화 안내를 그리지 않는다
  | { readonly kind: 'mock_open' } // 토요일 가상 영업시간 안: 모의 전화 버튼
  | { readonly kind: 'saturday_closed' } // 토요일 가상 영업시간 밖: 운영 안내만, 버튼 없음
  | { readonly kind: 'sunday_notice' }; // 일요일: 토요일 운영 안내만, 버튼 없음

/** 한국 시간(UTC+9, 서머타임 없음)의 요일과 하루 중 분 */
export function kstParts(now: Date): { day: number; minutes: number } | null {
  const t = now.getTime();
  if (!Number.isFinite(t)) return null;
  const k = new Date(t + 9 * 60 * 60 * 1000);
  return { day: k.getUTCDay(), minutes: k.getUTCHours() * 60 + k.getUTCMinutes() };
}

export function phoneState(now: Date): PhoneState {
  const p = kstParts(now);
  if (!p) return { kind: 'hidden' };
  if (p.day === 6) {
    return p.minutes >= MOCK_SATURDAY_OPEN_MIN && p.minutes < MOCK_SATURDAY_CLOSE_MIN ? { kind: 'mock_open' } : { kind: 'saturday_closed' };
  }
  if (p.day === 0) return { kind: 'sunday_notice' };
  return { kind: 'hidden' };
}

/** 전화 안내 영역에 붙이는 구분 문구: 전화 상담 가능 요일과 기사 방문 가능일은 별개 */
export const PHONE_VS_VISIT_NOTE = '전화 상담이 가능한 시간과 기사가 방문할 수 있는 날은 달라요. 방문 가능일은 확인 전에는 알 수 없어요.';

export const MOCK_CALL_RESULT = '모의 전화예요. 실제로 전화가 걸리거나 담당자에게 전달되지 않아요.';

// ── 승인된 상담 예시 두 건(PR 7010893389 / 7011431185 승인 문구) ─────────────────
export const EXAMPLES: readonly { readonly title: string; readonly ask: string; readonly answer: string }[] = [
  {
    title: '설치비와 토요일 설치를 물을 때',
    ask: '이사 가는데 설치비가 얼마고 토요일에 설치되나요?',
    answer: '설치비는 상품과 설치 조건에 따라 달라요. 토요일 설치도 가능 여부를 확인해야 해요. 지금은 금액이나 일정을 확정해 드릴 수 없어요.',
  },
  {
    title: '담당자 연결을 요청할 때',
    ask: '담당자랑 바로 연결해 주세요.',
    answer: '현재 담당자 연결을 확인할 수 없어요. 이 문의가 전달됐다고 말씀드릴 수는 없어요. 금액이나 일정은 확정해 드릴 수 없어요.',
  },
];

// ── 질문형 FAQ ───────────────────────────────────────────────
export const FAQ: readonly { readonly q: string; readonly a: string }[] = [
  { q: '이 화면에서 바로 가입되나요?', a: '아니요. 지금은 선택한 조건을 정리해 보여 주는 가상 시안이에요. 가입·접수·예약은 되지 않아요.' },
  { q: '사은품은 어디가 더 많아요?', a: '같은 약정 기간으로 놓고 월 요금, 장비 비용, 설치비를 먼저 나란히 보면 실제 부담이 보여요. 사은품은 지급 조건까지 확인된 것만 따로 비교하는 게 정확해요.' },
  { q: '500메가면 충분해요?', a: '동시에 쓰는 기기와 쓰는 방식에 따라 달라요. 위에서 고른 조건으로 확인할 항목을 정리해 드려요. 속도만 올리기 전에 공유기 위치와 구성도 함께 봐요.' },
  { q: '이번 토요일 설치가 확정되나요?', a: '아직 확정된 일정이 없어요. 설치비와 그날 가능한 시간은 확인이 필요해요. 지금은 일정을 확정해 드릴 수 없어요.' },
  { q: '설치비는 처음에 내나요?', a: '설치비 금액과 청구 시점은 확인이 필요해요. 처음에 내는지는 지금 말씀드릴 수 없어요. 확인할 때는 매달 나가는 월 요금·장비 임대료와 설치 관련 비용을 나눠서 물어보세요.' },
  { q: '우리 집이나 매장에 설치가 되는지 어떻게 알 수 있어요?', a: '주소와 건물 조건을 확인해야 알 수 있어요. 이 화면은 주소를 받지 않아서 지금은 알 수 없어요. 설치 가능 여부와 희망 일정은 확인할 항목으로만 정리해 드려요.' },
  { q: '전화 상담이 되는 토요일이면 그날 설치도 되나요?', a: '전화 상담이 가능해도 설치 일정은 별도로 확인해야 해요. 담당자와 전화로 상담할 수 있는 요일과 기사가 방문할 수 있는 날은 별개예요. 방문 가능일은 설치 조건을 확인한 뒤에야 알 수 있고, 지금은 정해 드릴 수 없어요.' },
];

// ── 개인정보 FAQ(지금 입력할 정보 · 다음 단계 처리 주체) ─────────────────────
export const PRIVACY_FAQ: readonly { readonly q: string; readonly a: string }[] = [
  {
    q: '지금 이 화면에 어떤 정보를 입력하나요?',
    a: '아무것도 입력하지 않아요. 이 화면에는 글자를 쓰는 칸이 없고, 보기에서 고르기만 해요. 실명·전화번호·주소·주민등록번호·신분증·계좌 정보를 받지 않아요.',
  },
  {
    q: '고른 내용은 어디로 가나요?',
    a: '이 화면 안에서만 쓰여요. 다른 곳으로 보내거나 저장하지 않고, 화면을 닫거나 새로 고치면 사라져요. 방문 분석 도구도 쓰지 않아요.',
  },
  {
    q: '가입을 원하면 다음엔 어떻게 되나요?',
    a: '이 시안에는 그 단계가 없어요. 이후 접수 단계를 만들 때는 정보를 받기 전에 받는 정보, 처리하는 곳, 보관 기간, 동의 방법을 먼저 안내해야 하고, 아직 확정되지 않았어요. 채팅으로 신분증·주민등록번호·계좌 정보는 받지 않아요.',
  },
];
