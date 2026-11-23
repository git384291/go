// Google Ads 반응형 검색광고(RSA) 소재 조립 — 순수 함수(PM 11/23 B·C 승인). 외부 호출·집행 없음.
// - 문구는 새로 만들지 않는다: 이미 검수된 고정 문안(adTargetCopy)과 기존 검증기(validateAdCopy: 금지 주장·금액·숫자·브랜드 차단)를 그대로 거친 것만 쓴다.
// - 공식 한도(Google Ads API 문서 "Creating Responsive Search Ads"): 제목 3~15개·각 30자, 설명 2~4개·각 90자, 중복 문구는 DUPLICATE_ASSET 오류.
//   한국어 등 전각 문자는 1자를 2자로 센다(Google Ads 도움말 "About text ads"). 그래서 화면 글자 수가 아니라 이 너비로 잰다.
// - 최종 URL은 서버 환경변수(AD_LANDING_URL)의 https 주소만, 추적 꼬리표는 utm_source=google·utm_medium=cpc·utm_campaign=<캠페인 키>(상담·접수 집계와 같은 키 형식).
import { AD_TARGET_COPY } from '../../content/adTargetCopy';
import { CAMPAIGN_KEY } from '../../content/attribution';
import { AD_FORBIDDEN_CLAIMS } from '../../content/adDrafts';
import { validateAdCopy } from './adGeneration';

export const RSA_HEADLINE_MAX_WIDTH = 30;
export const RSA_DESCRIPTION_MAX_WIDTH = 90;
export const RSA_HEADLINES = { min: 3, max: 15 } as const;
export const RSA_DESCRIPTIONS = { min: 2, max: 4 } as const;

export type RsaCreative = { readonly headlines: readonly string[]; readonly descriptions: readonly string[] };

const WIDE = /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-힯ힰ-퟿豈-﫿︰-﹏＀-｠￠-￦]/u;
/** Google Ads 글자 수(전각 문자 2, 나머지 1) */
export function googleTextWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/** 검수 문안 목록 → RSA 소재. 각 문안은 validateAdCopy를 다시 통과해야 하고, 너비 초과·중복은 버린다. 개수가 모자라면 null(만들지 않음) */
export function buildRsaCreative(copies: readonly unknown[]): RsaCreative | null {
  const h: string[] = [];
  const d: string[] = [];
  for (const c of copies) {
    const v = validateAdCopy(c);
    if (!v.ok) continue;
    if (googleTextWidth(v.title) <= RSA_HEADLINE_MAX_WIDTH && !h.includes(v.title) && h.length < RSA_HEADLINES.max) h.push(v.title);
    if (googleTextWidth(v.description) <= RSA_DESCRIPTION_MAX_WIDTH && !d.includes(v.description) && d.length < RSA_DESCRIPTIONS.max) d.push(v.description);
  }
  if (h.length < RSA_HEADLINES.min || d.length < RSA_DESCRIPTIONS.min) return null;
  return Object.freeze({ headlines: Object.freeze(h), descriptions: Object.freeze(d) });
}

/** 기본 소재: 검수된 핵심 타깃 문안 5종 */
export const approvedRsaCreative = (): RsaCreative | null =>
  buildRsaCreative(Object.values(AD_TARGET_COPY).map((x) => ({ title: x.title, description: x.description })));

/** 최종 URL: https, 사용자 정보·쿼리·조각·IP 주소 없음, 점이 있는 호스트. 아니면 null(광고를 만들지 않음) */
export function landingUrlFrom(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 512) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port) return null;
    if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 광고 클릭 → 상담·접수 추적 꼬리표(접수 화면 attribution과 같은 키 형식) */
export function finalUrlSuffixFor(campaign: string): string | null {
  return CAMPAIGN_KEY.test(campaign) ? `utm_source=google&utm_medium=cpc&utm_campaign=${campaign}` : null;
}

/** 광고 그룹 생성 본문(항상 PAUSED, 검색 표준). 입찰가는 정하지 않는다(승인된 금액 근거 없음) */
export const adGroupCreatePayload = (name: string, campaignResource: string) =>
  ({ name, campaign: campaignResource, status: 'PAUSED', type: 'SEARCH_STANDARD' });
/** 반응형 검색광고 생성 본문(항상 PAUSED) */
export const adGroupAdCreatePayload = (adGroupResource: string, creative: RsaCreative, finalUrl: string, finalUrlSuffix: string) => ({
  adGroup: adGroupResource,
  status: 'PAUSED',
  ad: {
    finalUrls: [finalUrl],
    finalUrlSuffix,
    responsiveSearchAd: { headlines: creative.headlines.map((text) => ({ text })), descriptions: creative.descriptions.map((text) => ({ text })) },
  },
});

// ───── 검색 키워드(PM 11/24 1번 승인) — 순수 함수. 외부 호출·집행 없음 ─────
// - 키워드는 새로 만들지 않는다: 검수된 고정 문안(adTargetCopy)의 검색어 후보 중 **승인 목록**에 있는 것만 쓴다. 목록 밖 문구·입력은 전부 거부(NOT_APPROVED).
// - 매치 유형은 EXACT 하나뿐이다(BROAD·PHRASE 생성 코드 없음). 입찰가(CPC)는 정하지 않는다 — Keyword Planner 실데이터·PM 승인 전 확정 금지.
// - 범위: 현재 운영 상품(인터넷+TV)만. 인터넷·TV 말이 없거나 예약 상품(휴대폰·유심·CCTV·집전화 등) 말이 들어가면 거부한다.
// - 하나라도 거부되면 전체를 만들지 않는다(null). 비어 있어도 null(키워드 없는 광고는 만들지 않는다).
export const KEYWORD_MAX_WIDTH = 80;
export const KEYWORD_MAX_WORDS = 10;
export const KEYWORDS_MAX = 20;
export type AdKeyword = { readonly text: string; readonly matchType: 'EXACT' };
export type KeywordSet = readonly AdKeyword[];
export type KeywordRejection = 'SHAPE' | 'FORMAT' | 'OUT_OF_SCOPE' | 'PRODUCT_NOT_ACTIVE' | 'FORBIDDEN' | 'NOT_APPROVED' | 'DUPLICATE' | 'EMPTY' | 'TOO_MANY';

const KEYWORD_FORMAT = /^[가-힣A-Za-z0-9]+(?: [가-힣A-Za-z0-9]+)*$/;
const KEYWORD_SCOPE = /인터넷|tv|티비|iptv/i;
/** 현재 비활성(reserved) 상품 말: 휴대폰·유심·CCTV·집전화·알뜰폰 등. 카탈로그 reserved 상품과 맞춘다 */
export const KEYWORD_INACTIVE_PRODUCT_TERMS = Object.freeze(['휴대폰', '핸드폰', '스마트폰', '폰', '유심', 'usim', 'sim', 'cctv', '씨씨티비', '보안', '알뜰', '모바일', '전화', '5g', 'lte'] as const);

const keywordKey = (t: string) => t.toLowerCase().replace(/\s+/g, '');

/** 승인 목록(검수 문안의 검색어 후보). 같은 문구는 한 번만 */
export function approvedKeywordTexts(): readonly string[] {
  return Object.freeze([...new Set(Object.values(AD_TARGET_COPY).flatMap((x) => x.keywords))]);
}

/** 키워드 1개 검사. 통과하면 null, 아니면 거부 사유 */
export function checkKeyword(text: unknown, approved: readonly string[]): KeywordRejection | null {
  if (typeof text !== 'string') return 'SHAPE';
  if (text !== text.normalize('NFC') || !KEYWORD_FORMAT.test(text) || googleTextWidth(text) > KEYWORD_MAX_WIDTH || text.split(' ').length > KEYWORD_MAX_WORDS) return 'FORMAT';
  const low = text.toLowerCase();
  if (KEYWORD_INACTIVE_PRODUCT_TERMS.some((t) => low.includes(t))) return 'PRODUCT_NOT_ACTIVE';
  if (AD_FORBIDDEN_CLAIMS.some((b) => low.includes(b.toLowerCase()))) return 'FORBIDDEN';
  if (!KEYWORD_SCOPE.test(text)) return 'OUT_OF_SCOPE';
  if (!approved.includes(text)) return 'NOT_APPROVED';
  return null;
}

/** 후보 목록 → 키워드 집합(전부 EXACT). 하나라도 거부·중복이면 null(만들지 않음). 비어 있어도 null */
export function buildKeywordSet(candidates: readonly unknown[], approved: readonly string[] = approvedKeywordTexts()): KeywordSet | null {
  return keywordSetOrReason(candidates, approved).set;
}
/** 시험·진단용: 거부 사유까지 돌려준다 */
export function keywordSetOrReason(candidates: unknown, approved: readonly string[] = approvedKeywordTexts()): { set: KeywordSet | null; reason: KeywordRejection | null } {
  if (!Array.isArray(candidates)) return { set: null, reason: 'SHAPE' };
  if (candidates.length === 0) return { set: null, reason: 'EMPTY' };
  if (candidates.length > KEYWORDS_MAX) return { set: null, reason: 'TOO_MANY' };
  const seen = new Set<string>();
  const out: AdKeyword[] = [];
  for (const c of candidates) {
    const r = checkKeyword(c, approved);
    if (r) return { set: null, reason: r };
    const k = keywordKey(c as string);
    if (seen.has(k)) return { set: null, reason: 'DUPLICATE' };
    seen.add(k);
    out.push(Object.freeze({ text: c as string, matchType: 'EXACT' as const }));
  }
  return { set: Object.freeze(out), reason: null };
}

/** 기본 키워드: 승인 목록 전체(검수 문안의 검색어 후보 10개) */
export const approvedKeywords = (): KeywordSet | null => buildKeywordSet(approvedKeywordTexts());

/** 어댑터에 주입된 값이 승인된 EXACT 집합인지 다시 확인(호출자를 믿지 않는다) */
export function isApprovedKeywordSet(x: unknown): x is KeywordSet {
  if (!Array.isArray(x) || x.length === 0) return false;
  if (!x.every((k) => typeof k === 'object' && k !== null && Object.keys(k).length === 2 && (k as AdKeyword).matchType === 'EXACT' && typeof (k as AdKeyword).text === 'string')) return false;
  return buildKeywordSet((x as AdKeyword[]).map((k) => k.text)) !== null;
}

/** 키워드 생성 본문(항상 PAUSED·EXACT, 입찰가 없음) */
export const adGroupCriterionCreatePayload = (adGroupResource: string, k: AdKeyword) =>
  ({ adGroup: adGroupResource, status: 'PAUSED', keyword: { text: k.text, matchType: 'EXACT' } });
