/**
 * 바른365 — (앱 밖 도구, 미연결) 콘텐츠 라이브러리
 * 목표: 상위 딜러(아정당·미소 등) 수준의 자연스러운 콘텐츠
 * 규칙: AI 티 나지 않게, 실제 상담 경험 기반 말투, 과장 없는 실제 수치
 *
 * 보안: PUBLISH_ENABLED=false 기본 — 사용자 승인 없이 게시 금지
 */

// ─── 콘텐츠 카테고리 ──────────────────────────────────────────────────────────

export type ContentCategory =
  | 'shorts_hook'       // 쇼츠 첫 3초 훅
  | 'shorts_script'     // 쇼츠 전체 스크립트 (60초 이하)
  | 'longform_script'   // 롱폼 스크립트 (3~8분)
  | 'title_set'         // 제목 후보군 (A/B 테스트용)
  | 'description'       // 영상 설명란
  | 'thumbnail_text'    // 썸네일 텍스트
  | 'comment_reply'     // 댓글 답변 템플릿

// ─── 실제 시장 데이터 (2026년 기준) ──────────────────────────────────────────

export const MARKET_DATA = {
  cashback: {
    SKB: { internet: 170_000, internetPlusTV: 520_000 },
    KT:  { internet: 140_000, internetPlusTV: 450_000 },
    LG:  { internet: 230_000, internetPlusTV: 470_000 },
  },
  monthlyFee: {
    SKB: { internet100: 17_600, internetPlusTVBasic: 30_800 },
    KT:  { internet: 16_500 },
    LG:  { internet: 16_500 },
  },
  features: {
    SKB: ['인터넷+TV 현금 최대 52만원', '애플TV 연동 최적', '결합 시 3사 최저가'],
    KT:  ['전국 대칭형 인터넷 (업·다운 동일)', '안정적인 속도', '넓은 커버리지'],
    LG:  ['넷플릭스·디즈니+ 제휴 요금제', '와이파이 공유기 무상 임대', '알뜰폰 결합 가능'],
  },
} as const;

// ─── 쇼츠 훅 (첫 3초 — 이탈률 결정) ─────────────────────────────────────────

export const SHORTS_HOOKS: string[] = [
  // 질문형 — 궁금증 유발
  '인터넷 약정 아직 살아있으세요? 그럼 이거 꼭 보세요.',
  '통신사 바꾸면 돈 준다는 거 알아요? 얼마나 주는지 직접 알아봤어요.',
  '매달 인터넷 요금 그냥 내고 계신 분, 손해 보고 계신 겁니다.',
  '인터넷 사은품 최대 얼마까지 받을 수 있는지 알아요?',
  '약정 만료되면 꼭 해야 하는 거 있어요. 모르면 계속 비싼 요금 냅니다.',

  // 충격·반전형
  '인터넷 요금 그대로 내면서 현금 최대 52만 원 받는 방법이 있어요.',
  '통신사 3곳 다 직접 비교해봤는데, 결과가 좀 충격이에요.',
  '같은 인터넷인데 사람마다 받는 혜택이 다른 이유가 있어요.',

  // 공감형
  '저도 처음엔 몰랐어요. 인터넷 가입할 때 이걸 꼭 비교해야 한다는 걸.',
  '고객한테 제일 많이 받는 질문이에요. KT vs SKB vs LG 뭐가 나아요?',
]

// ─── 쇼츠 스크립트 세트 ───────────────────────────────────────────────────────

export interface ShortsScript {
  hook: string        // 첫 2~3초
  body: string        // 본론 (20~40초)
  cta: string         // 마무리 행동유도 (5~10초)
  tags: string[]
  estimatedSeconds: number
}

export const SHORTS_SCRIPTS: ShortsScript[] = [
  {
    hook: '인터넷 약정 만료됐는데 그냥 쓰고 계세요?',
    body: `솔직히 말씀드리면, 약정 끝나도 통신사는 먼저 연락 안 해요.\n그냥 두면 같은 요금 계속 내는 거거든요.\n\n그런데 지금 바꾸면 달라요.\nSK는 인터넷+TV 결합 시 최대 52만 원,\nLG는 공유기 무상에 넷플릭스 결합까지,\nKT는 대칭형 속도로 업로드 느린 분들한테 딱 맞아요.\n\n저한테 연락 주시면 세 곳 다 비교해서\n내 상황에 뭐가 제일 유리한지 무료로 알려드려요.`,
    cta: '아래 이메일이나 댓글로 주소 남겨주시면 바로 연락드릴게요.',
    tags: ['#인터넷가입', '#통신사비교', '#사은품', '#KT', '#SK', '#LG유플러스', '#Shorts'],
    estimatedSeconds: 55,
  },
  {
    hook: '통신사 3사 사은품, 직접 비교해봤어요.',
    body: `인터넷만 가입할 때:\n- LG유플러스: 최대 23만 원\n- SK브로드밴드: 최대 17만 원\n- KT: 최대 14만 원\n\n인터넷+TV 묶으면:\n- SK: 최대 52만 원 (3사 중 1위)\n- LG: 최대 47만 원\n- KT: 최대 45만 원\n\n근데 사은품만 보면 안 돼요.\n월 요금이랑 약정 조건도 같이 봐야 진짜 이득인지 알 수 있어요.\n저한테 물어보시면 계산해드려요, 무료로.`,
    cta: '상담 원하시면 댓글이나 이메일로 연락 주세요. 부담 없어요.',
    tags: ['#인터넷사은품', '#통신비절약', '#인터넷요금비교', '#Shorts'],
    estimatedSeconds: 50,
  },
  {
    hook: '인터넷 요금 매달 내는데, 얼마가 적당한 거예요?',
    body: `100Mbps 기준으로 단독 가입하면\n세 통신사 다 월 16,500~17,600원 정도예요.\n\n근데 TV 묶으면 다르거든요.\nSK 인터넷+TV 베이직 결합은 월 30,800원인데\n사은품은 최대 52만 원까지 나와요.\n\n2년 약정 기준으로 계산하면\n첫 해 실질 비용이 완전히 달라지는 거죠.\n\n지금 내는 요금이 얼마인지 모르겠다면\n고지서 사진 하나만 보내주세요.\n제가 더 싼 방법 있는지 바로 확인해드릴게요.`,
    cta: '인천 미추홀구 기반이지만 전국 상담 다 돼요.',
    tags: ['#인터넷요금', '#월정액', '#통신비', '#절약', '#Shorts'],
    estimatedSeconds: 58,
  },
]

// ─── 롱폼 스크립트 세트 ───────────────────────────────────────────────────────

export interface LongformScript {
  title: string
  intro: string       // 1분 이내
  sections: { heading: string; content: string }[]
  outro: string
  tags: string[]
  estimatedMinutes: number
}

export const LONGFORM_SCRIPTS: LongformScript[] = [
  {
    title: '2026년 인터넷 통신사 비교 — KT vs SK vs LG, 뭐가 진짜 이득인지 계산해봤어요',
    intro: `안녕하세요, 인천에서 인터넷·TV 상담을 하고 있는 바른365입니다.\n\n오늘은 질문 많이 받는 거 하나 제대로 정리해드리려고요.\n"KT, SK, LG 중에 뭐가 나아요?"\n\n이 질문에 정답은 없어요. 상황마다 달라거든요.\n근데 어떤 상황에 뭐가 유리한지는 명확하게 나와요.\n오늘 그 기준을 정리해드릴게요.`,
    sections: [
      {
        heading: '① 사은품만 보면 안 되는 이유',
        content: `많은 분들이 사은품 금액만 보고 결정하시는데, 이게 함정이에요.\n\n예를 들어 SK가 사은품을 52만 원 준다고 해도,\n월 요금이 KT보다 높으면 2년 뒤에는 KT가 더 쌀 수 있거든요.\n\n사은품 + 월 요금 × 24개월을 같이 계산해야 진짜 비교가 되는 거예요.\n저는 이걸 "총비용 계산"이라고 부르는데, 이게 핵심이에요.`,
      },
      {
        heading: '② 통신사별 실제 차이',
        content: `KT는 뭐가 달라요?\n대칭형 인터넷이 강점이에요. 업로드 속도가 다운로드랑 같아요.\n재택근무하시거나 영상 편집물 올리시는 분들한테 KT가 맞아요.\n\nSK는요?\n인터넷+TV 결합 혜택이 3사 중 제일 커요.\n현재 최대 52만 원까지 나와요.\n애플TV 연동도 SK가 제일 자연스러워요.\n\nLG는?\n넷플릭스, 디즈니+랑 결합 요금제가 있어서\n OTT 많이 보시는 분들한테 유리해요.\n공유기도 무상으로 주고요.`,
      },
      {
        heading: '③ 상황별 추천',
        content: `혼자 사세요, 인터넷만 쓰세요 → LG유플러스 (사은품 최대 23만 원)\n가족이랑 사세요, TV도 보세요 → SK브로드밴드 (사은품 최대 52만 원)\n재택근무, 영상업로드 많아요 → KT (대칭형 속도)\nOTT 구독 많아요 → LG (넷플릭스·디즈니+ 결합)`,
      },
      {
        heading: '④ 직접 상담 받으면 뭐가 달라요?',
        content: `솔직히 말씀드리면, 통신사 홈페이지에서 직접 가입하는 거랑\n대리점 통해서 가입하는 거랑 요금 차이 없어요.\n\n근데 혜택은 달라요.\n통신사 본사에서는 현금을 안 줘요. 상품권이나 가전으로 줘요.\n대리점 통하면 현금으로 받을 수 있거든요.\n\n그리고 비교하는 시간을 아낄 수 있어요.\n저한테 연락 주시면 세 곳 다 조건 뽑아서 한눈에 비교해드리거든요.`,
      },
    ],
    outro: `오늘 영상 도움 되셨으면 구독이랑 좋아요 눌러주시고요.\n상담 필요하신 분은 댓글이나 이메일로 연락 주세요.\n부담 없이 여쭤보셔도 돼요. 감사합니다.`,
    tags: ['인터넷가입', '통신사비교', 'KT', 'SK브로드밴드', 'LG유플러스', '인터넷사은품', '인터넷요금비교', '바른365'],
    estimatedMinutes: 5,
  },
]

// ─── 제목 세트 (A/B 테스트) ──────────────────────────────────────────────────

export interface TitleSet {
  topic: string
  titles: string[]
}

export const TITLE_SETS: TitleSet[] = [
  {
    topic: '사은품 비교',
    titles: [
      'KT vs SK vs LG 인터넷 사은품 직접 비교해봤어요 (2026년 최신)',
      '인터넷 가입하면 현금 얼마까지 받을 수 있나요? 계산해봤습니다',
      '통신사 3사 사은품 비교 — 뭐가 진짜 이득인지 알려드릴게요',
      '인터넷 사은품 최대 52만 원? 조건 따져봤더니...',
    ],
  },
  {
    topic: '절약 방법',
    titles: [
      '인터넷 요금 매달 그냥 내면 손해입니다 — 이렇게 하세요',
      '약정 만료 후에도 같은 요금 내는 분들 계신가요? 바꾸는 방법 알려드려요',
      '통신비 아끼는 방법, 복잡하지 않아요 — 이것만 확인하세요',
      '인터넷 요금 1년에 20만 원 아끼는 법 (실제 사례)',
    ],
  },
  {
    topic: '통신사별 특징',
    titles: [
      '재택근무한다면 KT 인터넷 선택해야 하는 이유',
      'OTT 많이 보세요? LG유플러스 결합 요금제 보세요',
      'SK브로드밴드 인터넷+TV 결합, 진짜 싼지 계산해봤어요',
      '통신사별 진짜 차이 — 속도, 사은품, 요금 모두 비교',
    ],
  },
]

// ─── 영상 설명란 템플릿 ──────────────────────────────────────────────────────

export function buildDescription(params: {
  videoTitle: string
  keyPoints: string[]
  includeTimestamps?: { time: string; label: string }[]
}): string {
  const { videoTitle, keyPoints, includeTimestamps } = params

  const pointsText = keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')
  const tsText = includeTimestamps
    ? '\n\n【목차】\n' + includeTimestamps.map(t => `${t.time} ${t.label}`).join('\n')
    : ''

  return `${videoTitle}${tsText}

【핵심 내용】
${pointsText}

---
바른365 | 인천 미추홀구 인터넷·TV 전문 상담
무료 비교 견적 → homme8904@naver.com

통신사별 가장 유리한 조건 비교해드려요.
부담 없이 문의해 주세요 :)

#인터넷가입 #통신사비교 #인터넷사은품 #KT #SK브로드밴드 #LG유플러스 #바른365 #인터넷요금비교`
}

// ─── 댓글 답변 템플릿 ────────────────────────────────────────────────────────

export const COMMENT_REPLIES: Record<string, string> = {
  price_inquiry: '안녕하세요 :) 현재 주소지 기준으로 조건이 달라져서요, 이메일(homme8904@naver.com)로 주소 알려주시면 바로 계산해드릴게요!',
  which_is_better: '어떤 용도로 쓰시는지 알려주시면 맞춤으로 추천드릴게요. 댓글이나 이메일 주세요 :)',
  can_i_switch: '네, 약정 중에도 바꾸실 수 있는 경우 있어요. 위약금 계산 같이 해드릴게요. 편하게 연락 주세요!',
  general_thanks: '도움이 됐다니 다행이에요 😊 궁금한 거 생기시면 언제든지 댓글 달아주세요!',
}

// ─── 콘텐츠 선택 헬퍼 ────────────────────────────────────────────────────────

export function pickShortsScript(index = 0): ShortsScript {
  return SHORTS_SCRIPTS[index % SHORTS_SCRIPTS.length]
}

export function pickLongformScript(index = 0): LongformScript {
  return LONGFORM_SCRIPTS[index % LONGFORM_SCRIPTS.length]
}

export function pickTitleSet(topic: string): TitleSet | undefined {
  return TITLE_SETS.find(ts => ts.topic === topic)
}

export function pickHook(index = 0): string {
  return SHORTS_HOOKS[index % SHORTS_HOOKS.length]
}
