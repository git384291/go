// Google Ads 반응형 검색광고(RSA) 소재 조립 — 순수 함수(PM 11/23 B·C 승인). 외부 호출·집행 없음.
// - 문구는 새로 만들지 않는다: 이미 검수된 고정 문안(adTargetCopy)과 기존 검증기(validateAdCopy: 금지 주장·금액·숫자·브랜드 차단)를 그대로 거친 것만 쓴다.
// - 공식 한도(Google Ads API 문서 "Creating Responsive Search Ads"): 제목 3~15개·각 30자, 설명 2~4개·각 90자, 중복 문구는 DUPLICATE_ASSET 오류.
//   한국어 등 전각 문자는 1자를 2자로 센다(Google Ads 도움말 "About text ads"). 그래서 화면 글자 수가 아니라 이 너비로 잰다.
// - 최종 URL은 서버 환경변수(AD_LANDING_URL)의 https 주소만, 추적 꼬리표는 utm_source=google·utm_medium=cpc·utm_campaign=<캠페인 키>(상담·접수 집계와 같은 키 형식).
import { AD_TARGET_COPY } from '../../content/adTargetCopy';
import { CAMPAIGN_KEY } from '../../content/attribution';
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
