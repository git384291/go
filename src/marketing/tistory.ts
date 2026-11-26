/**
 * 바른통신365 — 티스토리 자동 포스팅 모듈
 * 티스토리 Open API v1 사용 (OAuth 2.0)
 * 보안: PUBLISH_ENABLED=false 기본 — 사용자 승인 전 실제 게시 금지
 * 과금·계정 생성·배포 금지 / 토큰 출력 금지
 */

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type TistoryVisibility = 0 | 1 | 3; // 0=비공개, 1=보호, 3=공개

export interface TistoryPost {
  title: string;
  content: string;       // HTML 허용
  tags: string[];        // 최대 10개
  visibility: TistoryVisibility;
  categoryId?: string;
  publishedAt?: string;  // ISO 8601 (예약 발행)
}

export interface PostJob {
  id: string;
  post: TistoryPost;
  status: 'pending' | 'posting' | 'done' | 'failed' | 'duplicate';
  attempts: number;
  lastError?: string;
  postUrl?: string;
  postId?: string;
}

// ─── 중복 방지 ────────────────────────────────────────────────────────────────

const postedTitles = new Set<string>();

export function isDuplicatePost(title: string): boolean {
  return postedTitles.has(title.trim().toLowerCase());
}

function markPosted(title: string): void {
  postedTitles.add(title.trim().toLowerCase());
}

// ─── 검증 ────────────────────────────────────────────────────────────────────

export interface PostValidation {
  valid: boolean;
  errors: string[];
}

export function validatePost(post: TistoryPost): PostValidation {
  const errors: string[] = [];

  if (!post.title || post.title.trim().length === 0)
    errors.push('제목 필수');
  if (post.title.length > 150)
    errors.push(`제목 150자 초과 (현재 ${post.title.length}자)`);
  if (!post.content || post.content.trim().length === 0)
    errors.push('본문 필수');
  if (post.tags.length > 10)
    errors.push(`태그 최대 10개 (현재 ${post.tags.length}개)`);
  if (isDuplicatePost(post.title))
    errors.push(`중복 제목 차단: "${post.title}"`);

  return { valid: errors.length === 0, errors };
}

// ─── 콘텐츠 템플릿 (C-Rank SEO 대응, 1,500자↑, 구어체) ─────────────────────

export interface TistoryTemplate {
  id: string;
  post: TistoryPost;
}

export const TISTORY_POSTS: TistoryTemplate[] = [
  {
    id: 'tistory_01',
    post: {
      title: '인천 인터넷 가입 혜택 총정리 2026 — SK KT LG 현금 사은품 비교',
      visibility: 3,
      tags: ['인천인터넷', '인터넷가입혜택', 'SK브로드밴드', 'KT인터넷', 'LG유플러스', '인터넷사은품', '인터넷TV결합', '바른통신365', '인천미추홀구', '인터넷요금'],
      content: `<h2>인천에서 인터넷 가입할 때 사은품 얼마나 받을 수 있을까요?</h2>

<p>저는 인천 미추홀구에서 인터넷·TV 상담을 하고 있는데요, 하루에도 "어디서 가입하면 가장 유리해요?"라는 질문을 여러 번 받습니다. 솔직히 말씀드리면, 가입 시점이나 프로모션에 따라 달라지긴 하지만 2026년 현재 기준으로 정리해 드릴게요.</p>

<h3>SK브로드밴드 — 현금 최대 52만 원</h3>

<p>SK브로드밴드는 인터넷+TV 결합 상품 가입 시 현금 사은품을 가장 많이 주는 편입니다. 기가인터넷(1Gbps) 기준으로 2년 약정 시 현금 약 52만 원 수준을 받을 수 있어요. 다만 이건 딜러마다 다를 수 있고, 결합 상품 구성에 따라 조금씩 차이가 납니다. AS 측면에서는 인천 지역 커버리지가 넓어서 불만 사례가 상대적으로 적은 편이에요.</p>

<h3>LG유플러스 — 현금 최대 47만 원</h3>

<p>LG유플러스는 IPTV(U+tv) 콘텐츠가 강점입니다. 아이들 있는 집에서 선호하는 경향이 있어요. 현금 사은품은 약 47만 원 선이고요. 최근에는 기가 와이파이 무료 설치를 같이 해주는 프로모션도 종종 나옵니다. 개통 속도도 빠른 편이라 급하게 이사하신 분들한테 추천드릴 때가 많아요.</p>

<h3>KT — 현금 최대 45만 원</h3>

<p>KT는 브랜드 신뢰도가 높고 기업·소호 사무실 쪽에서 많이 쓰입니다. 가정용 인터넷 사은품은 약 45만 원 수준인데, KT 올레TV 콘텐츠나 KT 멤버십 혜택을 중요하게 보는 분들이 선택하시는 경우가 많아요.</p>

<h3>결합 상품이 무조건 유리할까요?</h3>

<p>인터넷+TV+이동통신 결합하면 월 요금 할인이 되는 건 맞는데, 무조건 결합이 유리한 건 아닙니다. 가족 중 타사 휴대폰을 쓰는 분이 있으면 결합 적용이 안 되고, TV를 거의 안 보는 집이라면 인터넷 단독으로 가입하는 게 나을 수 있어요. 직접 비교해 드리는 게 가장 정확합니다.</p>

<h3>인천 미추홀구 주민이라면</h3>

<p>저한테 연락 주시면 세 통신사 현재 프로모션을 한번에 비교해 드립니다. 무료 상담이고, 가입을 강요하지 않아요. 가장 유리한 조건 찾아드리는 게 제 역할이라고 생각하거든요.</p>

<p>문의는 프로필 링크 참고해 주세요.</p>`,
    },
  },
  {
    id: 'tistory_02',
    post: {
      title: '인터넷 약정 만료 후 그냥 쓰면 얼마나 손해일까 — 재약정 vs 타사 전환',
      visibility: 3,
      tags: ['인터넷약정만료', '인터넷재약정', '타사전환', '인터넷요금절약', '인터넷해지', '약정위약금', '인터넷비교', '바른통신365', '인천인터넷', '인터넷가입'],
      content: `<h2>약정 끝나고 그냥 쓰고 계신가요? 한 번 확인해 보세요</h2>

<p>의외로 많은 분들이 인터넷 약정이 끝난 걸 모르고 계속 쓰고 계십니다. 약정이 끝나면 자동으로 월정액이 그대로 유지되는데, 문제는 신규 가입자들이 받는 할인 혜택을 못 받는다는 거예요. 오늘은 이 부분을 자세히 정리해 드릴게요.</p>

<h3>약정 만료 후 어떻게 되나요?</h3>

<p>2년 약정이 끝나면 보통 '무약정 상태'로 전환됩니다. 월 요금은 약정 중이랑 비슷하게 나오는데, 위약금 없이 해지할 수 있다는 장점은 있어요. 근데 신규 가입 프로모션 현금 사은품은 못 받습니다. 이 차이가 꽤 큽니다. 신규 가입 사은품이 40~50만 원 수준이니까, 2년 추가로 쓰는 동안 그만큼 손해를 보는 셈이에요.</p>

<h3>재약정 vs 타사 전환 — 뭐가 유리할까요?</h3>

<p>재약정을 하면 현재 쓰는 통신사에서 추가 할인이나 소액 사은품을 주기도 합니다. 하지만 타사로 전환하면 현금 40~50만 원대 사은품을 새로 받을 수 있어요. 단, 개통 비용이나 설치 과정이 번거로울 수 있고, 위약금이 남아있다면 계산이 달라집니다. 이사나 인테리어 계획이 있으신 분들은 이 시점에 함께 처리하시면 편리합니다.</p>

<h3>약정 위약금 계산하는 방법</h3>

<p>가입한 통신사 고객센터에 전화하거나 앱에서 확인할 수 있어요. 위약금이 남아있더라도, 타사 전환 사은품이 더 크다면 전환하는 게 유리할 수 있습니다. 예를 들어 위약금 10만 원인데 사은품 50만 원이면 차익이 40만 원이잖아요. SK브로드밴드 기준으로는 약정 잔여 기간에 따라 위약금이 달라지니, 정확한 금액은 1588-2000으로 문의하시면 됩니다.</p>

<h3>인천 미추홀구 기준 현재 조건은?</h3>

<p>2026년 현재 인천 지역에서 타사 전환 시 받을 수 있는 현금 사은품은 SK브로드밴드 약 52만 원, LG유플러스 약 47만 원, KT 약 45만 원 수준입니다. 프로모션은 월별로 바뀌기 때문에, 지금 시점 정확한 조건은 직접 확인이 필요합니다. 저한테 연락 주시면 세 통신사를 한 번에 비교해 드립니다.</p>

<h3>직접 비교가 가장 빠릅니다</h3>

<p>저한테 현재 요금제랑 약정 만료일 알려주시면, 재약정·타사 전환 중 어느 쪽이 유리한지 계산해 드립니다. 인천 미추홀구 기준으로 현재 프로모션 조건도 같이 안내해 드릴게요. 무료 상담이고, 가입을 강요하지 않습니다. 비교만 해드려도 좋습니다.</p>`,
    },
  },
  {
    id: 'tistory_03',
    post: {
      title: '2026년 가정용 인터넷 속도 비교 — 10Gbps 필요한가요?',
      visibility: 3,
      tags: ['인터넷속도', '기가인터넷', '10Gbps', '인터넷비교', 'SK브로드밴드', 'KT인터넷', 'LG유플러스', '인터넷추천', '바른통신365', '인천'],
      content: `<h2>10Gbps 인터넷, 가정에서 실제로 필요할까요?</h2>

<p>요즘 통신사들이 10Gbps 광인터넷을 밀고 있는데, 솔직히 일반 가정에서 10Gbps가 필요한 경우는 많지 않아요. 광고만 보면 무조건 빠른 게 좋을 것 같지만, 실제로 어떤 속도가 맞는지 정리해 드릴게요.</p>

<h3>가정용 인터넷 속도 — 얼마면 충분할까요?</h3>

<p>4인 가족이 동시에 넷플릭스 4K 스트리밍, 화상통화, 온라인 게임을 해도 500Mbps면 충분합니다. 1Gbps(기가인터넷)면 여유 있고요. 10Gbps는 사실 소호 사무실이나 콘텐츠 제작자 정도 되어야 체감이 됩니다. 대용량 파일을 자주 업로드하거나, NAS 서버를 운영하는 분 정도가 아니라면 굳이 10Gbps에 비싼 돈 쓸 필요 없어요.</p>

<h3>SK브로드밴드 속도 옵션</h3>

<p>SK브로드밴드는 500Mbps, 1Gbps, 2.5Gbps, 10Gbps 플랜을 운영합니다. 가정용으로는 1Gbps가 가성비 좋아요. 가격 차이에 비해 10Gbps를 쓸 일이 많지 않거든요. 실제로 1Gbps 가입자와 10Gbps 가입자가 유튜브나 넷플릭스를 볼 때 체감 차이는 거의 없습니다.</p>

<h3>KT / LG유플러스 속도 옵션</h3>

<p>KT와 LG유플러스도 비슷한 구조입니다. 모두 최대 10Gbps를 지원하고, 실제 가정용 계약은 대부분 1Gbps로 하십니다. 세 통신사 모두 1Gbps 기준 실측 속도는 비슷한 수준이에요. 다만 공동 주택이나 오래된 건물은 실제 선로 상태에 따라 속도 차이가 날 수 있어요. 이 부분은 개통 전에 확인이 필요합니다.</p>

<h3>속도보다 중요한 건 뭘까요?</h3>

<p>속도보다 AS 품질, 개통 속도, 사은품 조건이 가입자한테는 더 중요한 경우가 많습니다. 인터넷이 끊기거나 느려졌을 때 빨리 처리해 주는 통신사가 체감상 훨씬 좋거든요. 인천 미추홀구 기준으로는 세 통신사 모두 커버리지가 괜찮습니다. 저 개인적으로는 AS 대응 속도 측면에서 SK브로드밴드가 인천 쪽에서 비교적 빠른 편이라는 피드백을 많이 받았어요.</p>

<h3>인터넷 선택 시 체크할 항목</h3>

<p>속도 외에 꼭 확인하실 게 있어요. 첫째, 현재 사용 중인 공유기가 1Gbps 이상을 지원하는지 확인하세요. 아무리 빠른 인터넷을 써도 공유기가 구형이면 의미 없습니다. 둘째, TV 결합 여부에 따라 사은품·요금이 크게 달라집니다. 셋째, 약정 기간 중 이사 계획이 있으면 이사 조건을 꼭 확인하세요.</p>

<h3>정리하면</h3>

<p>일반 가정이라면 1Gbps 기가인터넷으로 충분하고, 사은품·요금 조건을 비교해서 유리한 통신사로 선택하시면 됩니다. 인천 미추홀구에서 직접 비교 상담 해드리니 편하게 연락 주세요. 무료 상담입니다.</p>`,
    },
  },
];

export function getPostById(id: string): TistoryTemplate | undefined {
  return TISTORY_POSTS.find(p => p.id === id);
}

export function renderPostHtml(post: TistoryPost): string {
  const tagStr = post.tags.map(t => `<span class="tag">#${t}</span>`).join(' ');
  return `${post.content}\n\n<p class="tags">${tagStr}</p>`;
}

// ─── OAuth 2.0 토큰 로드 ──────────────────────────────────────────────────────

function loadAccessToken(): string {
  const token = process.env.TISTORY_ACCESS_TOKEN;
  if (!token) throw new Error('TISTORY_ACCESS_TOKEN 환경변수 없음');
  return token;
}

function loadBlogName(): string {
  const name = process.env.TISTORY_BLOG_NAME;
  if (!name) throw new Error('TISTORY_BLOG_NAME 환경변수 없음 (예: myblog)');
  return name;
}

// ─── 포스팅 ──────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 티스토리 Open API로 포스팅.
 * PUBLISH_ENABLED=false(기본)면 실제 게시 없이 'pending' 반환.
 */
export async function publishPost(
  job: PostJob,
  PUBLISH_ENABLED = false,
): Promise<PostJob> {
  // 1. 승인 전 차단
  if (!PUBLISH_ENABLED) {
    return { ...job, status: 'pending', lastError: '사용자 승인 필요 — 실제 게시 금지' };
  }

  // 2. 중복 체크
  if (isDuplicatePost(job.post.title)) {
    return { ...job, status: 'duplicate', lastError: `중복 제목: "${job.post.title}"` };
  }

  // 3. 검증
  const v = validatePost(job.post);
  if (!v.valid) {
    return { ...job, status: 'failed', lastError: v.errors.join('; ') };
  }

  // 4. 자격증명 로드
  let accessToken: string;
  let blogName: string;
  try {
    accessToken = loadAccessToken();
    blogName = loadBlogName();
  } catch (e) {
    return { ...job, status: 'failed', lastError: String(e) };
  }

  const url = 'https://www.tistory.com/apis/post/write';
  const content = renderPostHtml(job.post);

  const params = new URLSearchParams({
    access_token: accessToken,
    output: 'json',
    blogName,
    title: job.post.title,
    content,
    visibility: String(job.post.visibility),
    tag: job.post.tags.join(','),
    ...(job.post.categoryId ? { category: job.post.categoryId } : {}),
    ...(job.post.publishedAt ? { published: String(Math.floor(new Date(job.post.publishedAt).getTime() / 1000)) } : {}),
  });

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      const res = await fetch(`${url}?${params}`, { method: 'POST' });

      if (res.ok) {
        const data = await res.json() as { tistory: { status: string; postId: string; url: string } };
        if (data.tistory?.status === '200') {
          markPosted(job.post.title);
          return {
            ...job,
            status: 'done',
            attempts: attempt,
            postId: data.tistory.postId,
            postUrl: data.tistory.url,
          };
        }
        const errMsg = JSON.stringify(data.tistory);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
        return { ...job, status: 'failed', attempts: attempt, lastError: errMsg };
      }

      const errBody = await res.text();
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return { ...job, status: 'failed', attempts: attempt, lastError: `${res.status} ${errBody}` };

    } catch (e) {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return { ...job, status: 'failed', attempts: attempt, lastError: `예외: ${e}` };
    }
  }

  return { ...job, status: 'failed', attempts: attempt, lastError: '최대 재시도 초과' };
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

let jobCounter = 0;

export function createJobFromTemplate(templateId: string): PostJob | null {
  const tpl = getPostById(templateId);
  if (!tpl) return null;
  return {
    id: `tistory-job-${++jobCounter}-${Date.now()}`,
    post: tpl.post,
    status: 'pending',
    attempts: 0,
  };
}

export function getAllJobs(): PostJob[] {
  return TISTORY_POSTS.map(tpl => ({
    id: `tistory-job-${++jobCounter}-${Date.now()}`,
    post: tpl.post,
    status: 'pending' as const,
    attempts: 0,
  }));
}
