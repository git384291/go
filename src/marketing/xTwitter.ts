/**
 * 바른통신365 — X(트위터) 자동 포스팅 모듈
 * X API v2 Free tier 사용 (월 1,500 트윗 쓰기 한도)
 * 보안: PUBLISH_ENABLED=false 기본 — 사용자 승인 전 실제 게시 금지
 * 과금·계정 생성·배포 금지 / 토큰 출력 금지
 */

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export interface TweetMeta {
  text: string;           // 최대 280자
  replyToId?: string;     // 답글 대상 트윗 ID
  scheduledAt?: string;   // ISO 8601 — Free tier 미지원(참고용)
}

export interface TweetJob {
  id: string;
  meta: TweetMeta;
  status: 'pending' | 'posting' | 'done' | 'failed' | 'duplicate';
  attempts: number;
  lastError?: string;
  tweetId?: string;
}

export interface TweetResult {
  success: boolean;
  tweetId?: string;
  error?: string;
}

// ─── 중복 방지 ────────────────────────────────────────────────────────────────

const postedTexts = new Set<string>();

export function isDuplicateTweet(text: string): boolean {
  return postedTexts.has(text.trim().slice(0, 50)); // 앞 50자로 중복 판별
}

function markPosted(text: string): void {
  postedTexts.add(text.trim().slice(0, 50));
}

// ─── 텍스트 검증 ──────────────────────────────────────────────────────────────

export interface TweetValidation {
  valid: boolean;
  errors: string[];
  charCount: number;
}

export function validateTweet(meta: TweetMeta): TweetValidation {
  const errors: string[] = [];
  const charCount = meta.text.length;

  if (!meta.text || meta.text.trim().length === 0)
    errors.push('트윗 내용 필수');
  if (charCount > 280)
    errors.push(`280자 초과 (현재 ${charCount}자)`);
  if (isDuplicateTweet(meta.text))
    errors.push('중복 트윗 차단');

  return { valid: errors.length === 0, errors, charCount };
}

// ─── 콘텐츠 템플릿 ────────────────────────────────────────────────────────────

export interface TweetTemplate {
  id: string;
  category: 'short_promo' | 'benefit' | 'comparison' | 'question' | 'tip';
  text: string;
  tags: string[];
}

export const TWEET_TEMPLATES: TweetTemplate[] = [
  {
    id: 'promo_01',
    category: 'short_promo',
    text: '📡 인천 인터넷 가입 고민 중이세요?\n\nSK·KT·LG 중 어디가 유리한지\n직접 비교해 드립니다 💬\n\n현금 사은품 최대 70만원까지!\n무료 상담 → 프로필 링크\n\n#인터넷가입 #인천인터넷 #바른통신365',
    tags: ['인터넷가입', '인천인터넷', '바른통신365'],
  },
  {
    id: 'benefit_01',
    category: 'benefit',
    text: '🎁 2026년 인터넷 사은품 현황\n\nSK브로드밴드: 현금 52만원\nLG유플러스: 현금 47만원\nKT: 현금 45만원\n\n*결합 상품·약정 조건에 따라 차이 있음\n정확한 금액은 상담 후 확인!\n\n#인터넷사은품 #인터넷가입혜택',
    tags: ['인터넷사은품', '인터넷가입혜택'],
  },
  {
    id: 'question_01',
    category: 'question',
    text: '📶 인터넷 약정 만료됐는데 그냥 쓰고 계신가요?\n\n만료 후 자동 연장되면\n신규 가입자보다 비싸게 내는 경우 많아요\n\n재약정·타사 전환 비교해 드릴게요 👇\n무료 상담 → 프로필 링크\n\n#인터넷약정 #인터넷요금절약',
    tags: ['인터넷약정', '인터넷요금절약'],
  },
  {
    id: 'tip_01',
    category: 'tip',
    text: '💡 인터넷 + TV 결합하면 얼마나 저렴해질까?\n\n단독 가입보다 월 1~2만원 절약\n사은품도 결합 시 더 많이 받을 수 있어요\n\n인천 미추홀구 전문 상담사가 직접 비교해 드립니다\n\n#인터넷TV결합 #바른통신365 #인천',
    tags: ['인터넷TV결합', '바른통신365', '인천'],
  },
  {
    id: 'shorts_promo_01',
    category: 'short_promo',
    text: '🎬 [영상] SK vs KT vs LG 인터넷 사은품 비교\n\n어디서 가입하면 가장 유리할까?\n60초 안에 정리해 드립니다\n\n👇 유튜브 쇼츠 보러가기\n\n#인터넷비교 #유튜브쇼츠 #인터넷가입',
    tags: ['인터넷비교', '유튜브쇼츠', '인터넷가입'],
  },
  {
    id: 'comparison_01',
    category: 'comparison',
    text: '🔍 인터넷 속도 비교 (2026 기준)\n\nSK브로드밴드: 최대 10Gbps\nLG유플러스: 최대 10Gbps\nKT: 최대 10Gbps\n\n속도는 비슷해요 — 차이는 사은품·요금·AS 품질\n직접 비교해 드릴게요 💬\n\n#인터넷속도 #인터넷추천',
    tags: ['인터넷속도', '인터넷추천'],
  },
];

export function getTemplateById(id: string): TweetTemplate | undefined {
  return TWEET_TEMPLATES.find(t => t.id === id);
}

export function getTemplatesByCategory(
  category: TweetTemplate['category'],
): TweetTemplate[] {
  return TWEET_TEMPLATES.filter(t => t.category === category);
}

// ─── OAuth 1.0a 서명 (X API v2 Free tier) ────────────────────────────────────
// X API v2 무료: 월 1,500 트윗 쓰기 / OAuth 1.0a User Context 필요

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildOAuth1Header(
  method: string,
  url: string,
  creds: XCredentials,
  bodyParams: Record<string, string> = {},
): string {
  const { createHmac, randomBytes } = require('node:crypto');

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  // 파라미터 정렬 & 서명 베이스 생성
  const allParams = { ...oauthParams, ...bodyParams };
  const sortedParams = Object.keys(allParams)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams),
  ].join('&');

  const signature = createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  const headerValue = 'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(', ');

  return headerValue;
}

function loadCredentials(): XCredentials {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    throw new Error(
      'X API 환경변수 없음: X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET',
    );
  }
  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

// ─── 트윗 게시 ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * X API v2로 트윗 게시.
 * PUBLISH_ENABLED=false(기본)면 실제 게시 없이 'pending' 반환.
 */
export async function postTweet(
  job: TweetJob,
  PUBLISH_ENABLED = false,
): Promise<TweetJob> {
  // 1. 승인 전 차단
  if (!PUBLISH_ENABLED) {
    return { ...job, status: 'pending', lastError: '사용자 승인 필요 — 실제 게시 금지' };
  }

  // 2. 중복 체크
  if (isDuplicateTweet(job.meta.text)) {
    return { ...job, status: 'duplicate', lastError: '중복 트윗 차단' };
  }

  // 3. 검증
  const v = validateTweet(job.meta);
  if (!v.valid) {
    return { ...job, status: 'failed', lastError: v.errors.join('; ') };
  }

  // 4. 자격증명 로드
  let creds: XCredentials;
  try {
    creds = loadCredentials();
  } catch (e) {
    return { ...job, status: 'failed', lastError: String(e) };
  }

  const url = 'https://api.twitter.com/2/tweets';
  const body: Record<string, unknown> = { text: job.meta.text };
  if (job.meta.replyToId) {
    body.reply = { in_reply_to_tweet_id: job.meta.replyToId };
  }

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      const bodyStr = JSON.stringify(body);
      const authHeader = buildOAuth1Header('POST', url, creds);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: bodyStr,
      });

      if (res.status === 201 || res.ok) {
        const data = await res.json() as { data: { id: string } };
        markPosted(job.meta.text);
        return { ...job, status: 'done', attempts: attempt, tweetId: data.data.id };
      }

      // 429 Rate limit
      if (res.status === 429) {
        const retryAfter = res.headers.get('x-rate-limit-reset');
        const waitMs = retryAfter
          ? (Number(retryAfter) * 1000 - Date.now()) + 1000
          : RETRY_DELAY_MS;
        if (attempt < MAX_RETRIES) { await sleep(Math.min(waitMs, 60_000)); continue; }
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

// ─── 템플릿 기반 일괄 예약 큐 ────────────────────────────────────────────────

let jobCounter = 0;

export function createJobFromTemplate(templateId: string): TweetJob | null {
  const tpl = getTemplateById(templateId);
  if (!tpl) return null;
  return {
    id: `x-job-${++jobCounter}-${Date.now()}`,
    meta: { text: tpl.text },
    status: 'pending',
    attempts: 0,
  };
}

export function buildDailyQueue(): TweetJob[] {
  // 하루 2~3개 추천 (Free tier 월 1,500 한도 고려)
  const templateIds = ['promo_01', 'benefit_01', 'question_01'];
  return templateIds
    .map(id => createJobFromTemplate(id))
    .filter((j): j is TweetJob => j !== null);
}
