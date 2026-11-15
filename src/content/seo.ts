/**
 * 검색 노출 준비(PHASE 1). 기본값은 닫힘.
 * - 공식 주소(PUBLIC_SITE_ORIGIN)가 확정·설정되기 전에는 canonical·OG URL·sitemap을 만들지 않는다.
 *   요청 Host나 example·preview 주소를 정식 주소로 쓰지 않는다.
 * - 검색 허용은 운영(VERCEL_ENV=production) + SEARCH_INDEXING=allow + 공식 주소가 모두 있을 때만.
 *   단, 루트 layout의 noindex는 그대로 둔다(해제는 PM 검수용 변경안: docs/LAUNCH-READINESS.md).
 * - 관리자·진행판·API 경로는 어떤 경우에도 허용하지 않는다.
 */
type Env = Record<string, string | undefined>;

export const SITE_NAME = 'FIDEON';

/** 화면에 실제로 있는 내용만 요약한다(가격·혜택·평점·사업자 정보 없음) */
export const PAGE_META = {
  home: {
    path: '/',
    title: '인터넷 + TV 가입 상담',
    description: '인터넷과 TV를 이용 환경에 맞춰 통신사별 조건으로 비교해 상담하는 FIDEON입니다. 온라인 상담 신청은 준비 중입니다.',
  },
  internetTv: {
    path: '/products/internet-tv',
    title: '인터넷 + TV 결합 상담',
    description: '인터넷 속도, TV 구성, 결합 조건과 설치 전 확인 사항을 정리했습니다. 요금·혜택은 상담 시점의 정책으로 안내합니다.',
  },
  consult: {
    path: '/consult',
    title: '상담 신청 안내',
    description: '현재 FIDEON 온라인 상담 신청은 준비 중입니다.',
  },
  privacy: {
    path: '/privacy',
    title: '개인정보처리방침',
    description: 'FIDEON 개인정보처리방침입니다.',
  },
} as const;
export type PageKey = keyof typeof PAGE_META;

/** 검색 허용 시 sitemap에 넣는 공개 경로. 준비 중 접수 화면(/consult)은 접수 개방 승인 전까지 제외 */
export const SITEMAP_PATHS: readonly string[] = [PAGE_META.home.path, PAGE_META.internetTv.path, PAGE_META.privacy.path];

/** 어떤 경우에도 검색 허용하지 않는 경로 */
export const NEVER_INDEX = ['/admin', '/api'] as const;

const BLOCKED_HOST = /(^|\.)(example\.(com|org|net)|localhost|vercel\.app|invalid|test|local)$/i;

/** 공식 주소: https 원본(경로·쿼리·포트·사용자 정보 없음)만 인정 */
export function publicSiteOrigin(env: Env = process.env): string | null {
  const raw = (env.PUBLIC_SITE_ORIGIN ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (BLOCKED_HOST.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null;
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
