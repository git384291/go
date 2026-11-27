/**
 * 검색 노출 준비(PHASE 1). 기본값은 닫힘.
 * - 공식 주소(PUBLIC_SITE_ORIGIN)가 확정·설정되기 전에는 canonical·OG URL·sitemap을 만들지 않는다.
 *   요청 Host나 example·preview 주소를 정식 주소로 쓰지 않는다.
 * - 검색 허용은 운영(VERCEL_ENV=production) + SEARCH_INDEXING=allow + 공식 주소가 모두 있을 때만.
 *   단, 루트 layout의 noindex는 그대로 둔다(해제는 PM 검수용 변경안: docs/LAUNCH-READINESS.md).
 * - 관리자·진행판·API 경로는 어떤 경우에도 허용하지 않는다.
 */
type Env = Record<string, string | undefined>;

export const SITE_NAME = '바른365';

/** 화면에 실제로 있는 내용만 요약한다(가격·혜택·평점·사업자 정보 없음) */
export const PAGE_META = {
  home: {
    path: '/',
    title: '인터넷 + TV 가입 상담',
    description: '인터넷과 TV를 이용 환경에 맞춰 통신사별 조건으로 비교해 상담하는 바른365입니다. 온라인 상담 신청은 준비 중입니다.',
  },
  internetTv: {
    path: '/products/internet-tv',
    title: '인터넷 + TV 결합 상담',
    description: '인터넷 속도, TV 구성, 결합 조건과 설치 전 확인 사항을 정리했습니다. 요금·혜택은 상담 시점의 정책으로 안내합니다.',
  },
  consult: {
    path: '/consult',
    title: '상담 신청 안내',
    description: '현재 바른365 온라인 상담 신청은 준비 중입니다.',
  },
  privacy: {
    path: '/privacy',
    title: '개인정보처리방침',
    description: '바른365 개인정보처리방침입니다.',
  },
} as const;
export type PageKey = keyof typeof PAGE_META;

/** 검색 허용 시 sitemap에 넣는 공개 경로. 준비 중 접수 화면(/consult)은 접수 개방 승인 전까지 제외 */
export const SITEMAP_PATHS: readonly string[] = [PAGE_META.home.path, PAGE_META.internetTv.path, PAGE_META.privacy.path];

/** 어떤 경우에도 검색 허용하지 않는 경로 */
export const NEVER_INDEX = ['/admin', '/api'] as const;

/**
 * 공식 주소 정책(형식 검사일 뿐, 도메인 소유권 검증이 아니다. 소유 확인은 도메인 확정 후 별도로 한다).
 * - https 원본만(경로·쿼리·조각·포트·사용자 정보 없음)
 * - 호스트는 공개 DNS 이름만: IP 리터럴(IPv4·IPv6 [..])·단일 라벨 호스트 거부
 * - 라벨: 영소문자·숫자·하이픈 1~63자, 하이픈으로 시작·끝 불가, 전체 253자 이하
 * - 최상위 도메인: 영문 2자 이상 또는 IDN(xn--). 숫자 TLD 거부
 * - 내부·예약·예시 이름 거부: localhost, local, internal, intranet, lan, home, corp, test, example, invalid, onion, arpa,
 *   example.com/net/org, 미리보기 호스팅(vercel.app)
 */
const RESERVED_TLD = new Set(['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'example', 'invalid', 'onion', 'arpa', 'localdomain']);
const BLOCKED_SUFFIX = ['example.com', 'example.net', 'example.org', 'vercel.app'];
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function isPublicDnsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!h || h.length > 253 || h.startsWith('[') || h.includes(':')) return false; // IPv6 리터럴
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false; // 단일 라벨·빈 라벨
  if (labels.every((l) => /^\d+$/.test(l))) return false; // IPv4 리터럴
  const tld = labels[labels.length - 1];
  if (!(/^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld))) return false;
  if (RESERVED_TLD.has(tld)) return false;
  return !BLOCKED_SUFFIX.some((suf) => h === suf || h.endsWith(`.${suf}`));
}

/** 공식 주소: https 원본(경로·쿼리·포트·사용자 정보 없음) + 공개 DNS 이름만 인정 */
export function publicSiteOrigin(env: Env = process.env): string | null {
  const raw = (env.PUBLIC_SITE_ORIGIN ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (!isPublicDnsHost(u.hostname)) return null;
  return u.origin;
}

export function searchIndexingAllowed(env: Env = process.env): boolean {
  return env.VERCEL_ENV === 'production' && env.SEARCH_INDEXING === 'allow' && publicSiteOrigin(env) !== null;
}

/** 페이지 메타데이터: 공식 주소가 없으면 canonical·OG URL을 넣지 않는다 */
export function pageMetadata(key: PageKey, env: Env = process.env) {
  const m = PAGE_META[key];
  const origin = publicSiteOrigin(env);
  return {
    title: m.title,
    description: m.description,
    ...(origin
      ? {
          alternates: { canonical: `${origin}${m.path}` },
          openGraph: { type: 'website' as const, siteName: SITE_NAME, locale: 'ko_KR', title: m.title, description: m.description, url: `${origin}${m.path}` },
        }
      : {}),
  };
}

/** robots.txt 규칙. 닫힌 기본값은 전체 차단·sitemap 없음 */
export function robotsRules(env: Env = process.env) {
  if (!searchIndexingAllowed(env)) return { rules: [{ userAgent: '*', disallow: '/' }] };
  const origin = publicSiteOrigin(env)!;
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: NEVER_INDEX.map((p) => `${p}/`).concat(NEVER_INDEX) }],
    sitemap: `${origin}/sitemap.xml`,
  };
}

/** sitemap 항목. 닫힌 기본값은 빈 목록 */
export function sitemapEntries(env: Env = process.env): { url: string }[] {
  if (!searchIndexingAllowed(env)) return [];
  const origin = publicSiteOrigin(env)!;
  return SITEMAP_PATHS.map((p) => ({ url: `${origin}${p}` }));
}
