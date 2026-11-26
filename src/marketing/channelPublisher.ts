/**
 * 바른365 — 광고 채널 자동화 모듈
 * 보안: 실제 게시는 사용자 승인 후에만 실행 (PUBLISH_ENABLED=false 기본)
 * 과금·계정 생성·병합·배포 금지
 */

// ─── 채널 분류 ──────────────────────────────────────────────────────────────

export type ChannelTier = 'API_AUTO' | 'MANUAL' | 'FORBIDDEN';

export type Channel =
  | 'youtube'
  | 'instagram'
  | 'facebook'
  | 'blogger'
  | 'tiktok'
  | 'naver_blog'
  | 'naver_cafe'
  | 'naver_jisikin'
  | 'naver_band'
  | 'naver_clip'
  | 'tistory'
  | 'threads'
  | 'twitter_x'
  | 'ppomppu'
  | 'clien'
  | 'dcinside'
  | 'womens_site'
  | 'local_cafe';

export interface ChannelMeta {
  name: string;
  tier: ChannelTier;
  apiAvailable: boolean;
  commercialAllowed: boolean; // 공식 정책상 상업 홍보 허용 여부
  autoPostAllowed: boolean;   // 사용자 개입 없는 자동 게시 허용 여부
  note: string;
  apiRef?: string;
}

export const CHANNEL_REGISTRY: Record<Channel, ChannelMeta> = {
  // ── 🟢 공식 API 자동화 가능 채널 ──
  youtube: {
    name: 'YouTube Shorts/롱폼',
    tier: 'API_AUTO',
    apiAvailable: true,
    commercialAllowed: true,  // 자사 사업 홍보용 업로드 허용 (Policy III.G.2)
    autoPostAllowed: false,   // 사용자 명시적 동의 필요 (Policy III.I.2)
    note: '사용자 승인 후 업로드 가능. OAuth 필요. 쇼츠는 #Shorts 해시태그 + 세로영상.',
    apiRef: 'https://developers.google.com/youtube/v3/docs/videos/insert',
  },
  instagram: {
    name: 'Instagram 릴스/게시물',
    tier: 'API_AUTO',
    apiAvailable: true,
    commercialAllowed: true,
    autoPostAllowed: true,    // Graph API로 비즈니스 계정 발행 가능
    note: 'Instagram Graph API. 비즈니스 계정 + Facebook Page 연결 필요. 하루 100개 한도.',
    apiRef: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
  },
  facebook: {
    name: 'Facebook 페이지',
    tier: 'API_AUTO',
    apiAvailable: true,
    commercialAllowed: true,
    autoPostAllowed: true,    // Pages API로 발행 가능
    note: 'Graph API Pages API. pages_manage_posts 권한 필요. 예약 게시 지원.',
    apiRef: 'https://developers.facebook.com/docs/pages-api/posts',
  },
  blogger: {
    name: 'Google Blogger',
    tier: 'API_AUTO',
    apiAvailable: true,
    commercialAllowed: true,
    autoPostAllowed: true,    // Blogger API v3로 게시 가능
    note: 'Blogger API v3. OAuth2 필요. 네이버 블로그 대안으로 SEO 보조.',
    apiRef: 'https://developers.google.com/blogger/docs/3.0/using',
  },
  tiktok: {
    name: '틱톡',
    tier: 'API_AUTO',
    apiAvailable: true,
    commercialAllowed: true,
    autoPostAllowed: false,   // Direct Post API: 사용자 개입 필요. 심사 필요.
    note: '공식 Content Posting API 존재. 단, 앱 심사(TikTok 검토) 필요. 상업 콘텐츠는 광고 표시 의무.',
    apiRef: 'https://developers.tiktok.com/products/content-posting-api',
  },

  // ── 🟡 수동 게시 채널 ──
  naver_blog: {
    name: '네이버 블로그',
    tier: 'MANUAL',
    apiAvailable: false,      // 공식 게시 API 없음 (Open API는 읽기 전용)
    commercialAllowed: true,
    autoPostAllowed: false,
    note: '네이버 공식 게시 API 없음. AI 콘텐츠 생성 후 사용자 직접 게시. SEO 핵심 채널.',
  },
  naver_cafe: {
    name: '네이버 카페',
    tier: 'MANUAL',
    apiAvailable: false,
    commercialAllowed: false, // 카페별 상업 홍보 허용 여부 상이 → 사전 확인 필수
    autoPostAllowed: false,
    note: '카페별 홍보 허용 여부 확인 후 수동 게시. 무단 광고성 글 금지.',
  },
  naver_jisikin: {
    name: '네이버 지식iN',
    tier: 'MANUAL',
    apiAvailable: false,
    commercialAllowed: false, // 광고성 답변 금지 정책
    autoPostAllowed: false,
    note: '진성 답변만 허용. 광고성 URL 삽입 금지. 신뢰도 구축 목적으로만 활용.',
  },
  naver_band: {
    name: '네이버 밴드',
    tier: 'MANUAL',
    apiAvailable: false,
    commercialAllowed: false, // 그룹별 허용 여부 다름
    autoPostAllowed: false,
    note: '지역 밴드 운영자 허가 후 수동 게시. 40~60대 타겟.',
  },
  naver_clip: {
    name: '네이버 클립',
    tier: 'MANUAL',
    apiAvailable: false,
    commercialAllowed: true,
    autoPostAllowed: false,
    note: '네이버 쇼츠 형태. 직접 업로드. 네이버 검색 연동 강점.',
  },
  tistory: {
    name: '티스토리',
    tier: 'MANUAL',
    apiAvailable: true,       // Tistory API 존재하지만 카카오 정책으로 제한적
    commercialAllowed: true,
    autoPostAllowed: false,   // 카카오 보류 정책 적용
    note: '🟣 카카오 보류 정책에 따라 보류. API는 존재하나 카카오 계정 연동 필요.',
  },
  threads: {
    name: '스레드(Threads)',
    tier: 'MANUAL',
    apiAvailable: true,       // Threads API 2024년 출시
    commercialAllowed: true,
    autoPostAllowed: true,
    note: 'Meta Threads API 사용 가능. Instagram 계정 연동. 텍스트 중심 바이럴.',
    apiRef: 'https://developers.facebook.com/docs/threads',
  },
  twitter_x: {
    name: 'X(트위터)',
    tier: 'MANUAL',
    apiAvailable: true,
    commercialAllowed: true,
    autoPostAllowed: false,   // 유료 API 플랜 필요 (Basic $100/월~)
    note: '통신 딜러 타겟 적합도 낮음. API 유료. 우선순위 낮음.',
  },

  // ── 🔴 어뷰징 위험 / 금지 채널 ──
  ppomppu: {
    name: '뽐뿌',
    tier: 'FORBIDDEN',
    apiAvailable: false,
    commercialAllowed: false,
    autoPostAllowed: false,
    note: '무단 상업 게시 금지. 공식 광고 상품(핫딜 등록)만 허용. 자동화 금지.',
  },
  clien: {
    name: '클리앙',
    tier: 'FORBIDDEN',
    apiAvailable: false,
    commercialAllowed: false,
    autoPostAllowed: false,
    note: '상업 광고 엄격 금지. 적발 시 계정 영구 차단. 자동화 금지.',
  },
  dcinside: {
    name: '디시인사이드',
    tier: 'FORBIDDEN',
    apiAvailable: false,
    commercialAllowed: false,
    autoPostAllowed: false,
    note: '무단 광고 게시 금지. 어뷰징 위험 높음. 자동화 금지.',
  },
  womens_site: {
    name: '여성시대/맘카페',
    tier: 'FORBIDDEN',
    apiAvailable: false,
    commercialAllowed: false,
    autoPostAllowed: false,
    note: '상업 광고 금지. 위장 후기 엄격 금지. 자동화 금지.',
  },
  local_cafe: {
    name: '지역/아파트 커뮤니티',
    tier: 'FORBIDDEN',
    apiAvailable: false,
    commercialAllowed: false,
    autoPostAllowed: false,
    note: '운영자 허가 없는 상업 홍보 금지. 수동 허가 후에만 가능.',
  },
};

// ─── 콘텐츠 생성 ─────────────────────────────────────────────────────────────

export type ContentType = 'blog_post' | 'short_video_script' | 'image_card' | 'qa_answer';

export interface GeneratedContent {
  type: ContentType;
  title: string;
  body: string;
  tags: string[];
  targetChannel: Channel[];
  createdAt: string;
  approved: boolean; // 사용자 승인 전 false
}

const BLOG_TEMPLATES = [
  {
    title: '인천 미추홀구 인터넷 약정 만료 — 지금 확인하세요',
    body: `약정이 끝났는데 모르고 그냥 쓰시는 분들이 많아요.
매달 같은 요금 내고 있지만 사실 갈아타면 더 저렴하게, 사은품도 받을 수 있거든요.

**약정 만료일 확인하는 법**
1. 현재 사용 중인 통신사 고객센터 전화
2. 또는 통신사 앱에서 '내 서비스 현황' 확인

**약정 만료 후 선택지**
- 같은 통신사 재약정 (사은품 받기 가능)
- 타 통신사로 갈아타기 (더 큰 혜택 가능)

인천 미추홀구 지역에서 KT·SK브로드밴드·LG유플러스 무료 비교 상담 해드려요.
부담 없이 연락 주세요. 📧 homme8904@naver.com`,
    tags: ['인터넷약정만료', '인천인터넷', '인터넷갈아타기', '통신비절약', '인천미추홀구'],
  },
  {
    title: '이사하면 인터넷 어떻게 해야 할까요?',
    body: `이사 준비하실 때 인터넷 처리 방법이 헷갈리시죠?

**이사 시 인터넷 처리 방법 3가지**
1. **이전 설치** — 현재 통신사 그대로, 새 주소로 옮기기 (무료)
2. **해지 후 신규 가입** — 다른 통신사로 갈아타면서 사은품 받기
3. **약정 중도 해지 후 이전** — 위약금 여부 먼저 확인 필요

이사 날짜 2주 전에 미리 신청해야 설치 일정 잡기 편해요.

인천 미추홀구·남동구·연수구 지역 무료 상담.
📧 homme8904@naver.com`,
    tags: ['이사인터넷', '인터넷이전설치', '인천이사', '인터넷갈아타기', '이사준비'],
  },
  {
    title: 'KT vs SK브로드밴드 vs LG유플러스 — 뭐가 나을까요?',
    body: `통신사 세 군데 비교해드릴게요 (인터넷+TV 결합 기준).

| 구분 | KT | SK브로드밴드 | LG유플러스 |
|------|-----|------------|-----------|
| 안정성 | 최상 | 상 | 중 |
| 속도 | 중 | 최상 | 상 |
| 가격 경쟁력 | 낮음 | 중 | 높음 |
| TV 콘텐츠 | 풍부 | 중 | 풍부 |
| 신규 혜택 | 중 | 높음 | 높음 |

※ 지역·결합 조건에 따라 달라질 수 있어요.

내 상황에 맞는 선택, 무료로 상담해드려요.
인천 미추홀구 바른365 📧 homme8904@naver.com`,
    tags: ['통신사비교', 'KT인터넷', 'SK브로드밴드', 'LG유플러스', '인터넷요금비교'],
  },
];

const SHORTS_SCRIPTS = [
  {
    title: '지금 당장 인터넷 약정 만료일 확인하는 법',
    body: `[인트로 — 0~3초]
"인터넷 요금 그냥 내고 계세요? 약정 끝났는지 확인해보셨어요?"

[본문 — 3~20초]
"확인하는 방법, 엄청 간단해요."
"통신사 앱 열고 → 내 서비스 → 약정 만료일 확인"
"끝났으면 지금 갈아타면 사은품 받을 수 있어요."

[마무리 — 20~30초]
"인천 지역이시면 바른365에 연락 주시면"
"KT·SKB·LG유플러스 무료로 비교해드려요."
"댓글이나 DM 주세요!"

[자막/화면]
- 통신사 앱 화면 녹화
- 약정 만료일 표시 화면
- 연락처 자막`,
    tags: ['인터넷약정', '통신비절약', '인터넷갈아타기', '인천인터넷', 'Shorts'],
  },
  {
    title: '통신비 월 2만원 아끼는 방법',
    body: `[인트로]
"매달 나가는 인터넷 요금, 줄일 수 있어요."

[본문]
"Step 1 — 약정 만료일 확인"
"Step 2 — 타 통신사 견적 비교"
"Step 3 — 갈아타거나 재약정으로 협상"

"이것만 해도 월 1~2만원은 아껴요."

[마무리]
"복잡하면 바른365에 맡기세요. 무료 상담."
"인천 미추홀구. homme8904@naver.com"`,
    tags: ['통신비절약', '인터넷요금', '절약꿀팁', '인천인터넷', 'Shorts'],
  },
];

export function generateContent(type: ContentType, index = 0): GeneratedContent {
  const now = new Date().toISOString();

  if (type === 'blog_post') {
    const tpl = BLOG_TEMPLATES[index % BLOG_TEMPLATES.length];
    return {
      type,
      title: tpl.title,
      body: tpl.body,
      tags: tpl.tags,
      targetChannel: ['naver_blog', 'tistory', 'blogger'],
      createdAt: now,
      approved: false,
    };
  }

  if (type === 'short_video_script') {
    const tpl = SHORTS_SCRIPTS[index % SHORTS_SCRIPTS.length];
    return {
      type,
      title: tpl.title,
      body: tpl.body,
      tags: tpl.tags,
      targetChannel: ['youtube', 'tiktok', 'instagram', 'naver_clip'],
      createdAt: now,
      approved: false,
    };
  }

  return {
    type,
    title: '콘텐츠',
    body: '',
    tags: [],
    targetChannel: [],
    createdAt: now,
    approved: false,
  };
}

// ─── 중복 방지 ────────────────────────────────────────────────────────────────

const publishedHashes = new Set<string>();

function contentHash(content: GeneratedContent): string {
  // 제목 + 채널 조합으로 중복 체크
  return `${content.title}::${content.targetChannel.sort().join(',')}`;
}

export function isDuplicate(content: GeneratedContent): boolean {
  return publishedHashes.has(contentHash(content));
}

export function markPublished(content: GeneratedContent): void {
  publishedHashes.add(contentHash(content));
}

// ─── 게시 시뮬레이터 (실제 게시 금지 — 승인 전) ─────────────────────────────

export interface PublishResult {
  channel: Channel;
  status: 'PENDING_APPROVAL' | 'SKIPPED_FORBIDDEN' | 'SKIPPED_DUPLICATE' | 'READY';
  message: string;
}

export function preparePublish(
  content: GeneratedContent,
  PUBLISH_ENABLED = false, // 항상 false — 사용자 승인 전 실제 게시 금지
): PublishResult[] {
  const results: PublishResult[] = [];

  if (!content.approved) {
    return content.targetChannel.map((ch) => ({
      channel: ch,
      status: 'PENDING_APPROVAL',
      message: '사용자 승인 필요 — 실제 게시 금지',
    }));
  }

  for (const ch of content.targetChannel) {
    const meta = CHANNEL_REGISTRY[ch];

    if (meta.tier === 'FORBIDDEN') {
      results.push({ channel: ch, status: 'SKIPPED_FORBIDDEN', message: '어뷰징 위험 채널 — 자동화 금지' });
      continue;
    }

    if (isDuplicate(content)) {
      results.push({ channel: ch, status: 'SKIPPED_DUPLICATE', message: '중복 콘텐츠 차단' });
      continue;
    }

    if (!PUBLISH_ENABLED) {
      results.push({ channel: ch, status: 'PENDING_APPROVAL', message: `준비 완료 — 승인 후 ${meta.name}에 게시 가능` });
    } else {
      // 실제 게시는 여기서 각 채널 API 호출 (승인 후 구현)
      results.push({ channel: ch, status: 'READY', message: `${meta.name} 게시 준비 완료` });
      markPublished(content);
    }
  }

  return results;
}
