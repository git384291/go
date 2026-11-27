/**
 * 배포 환경 판별(한 곳). 호스팅(Vercel·Cloud Run)이 바뀌어도 운영이 개발로 새지 않게 한다(코사장 11/27).
 * - 운영(production): APP_ENV=production 또는 VERCEL_ENV=production 또는 Cloud Run 표준 K_SERVICE가 있음 — 하나라도 있으면 운영.
 *   표식이 충돌하면(예: K_SERVICE + APP_ENV=dev, VERCEL_ENV=preview + APP_ENV=production) 운영이 우선한다(안전한 쪽으로 닫힘).
 * - 검수(preview): 운영이 아니고 VERCEL_ENV=preview.
 * - 호스팅 배포(hosted): 운영·검수, 또는 VERCEL=1 / VERCEL_ENV 값이 있음 — 로컬 개발 전용 기능은 여기서 모두 닫힌다.
 * 순수 함수(입력 env만 읽음). 값·비밀은 기록하지 않는다.
 */
export type Env = Readonly<Record<string, string | undefined>>;

const has = (v: string | undefined) => typeof v === 'string' && v.trim() !== '';

export function isProduction(env: Env = process.env): boolean {
  return env.APP_ENV === 'production' || env.VERCEL_ENV === 'production' || has(env.K_SERVICE);
}

export function isPreview(env: Env = process.env): boolean {
  return !isProduction(env) && env.VERCEL_ENV === 'preview';
}

export function isHostedDeploy(env: Env = process.env): boolean {
  return isProduction(env) || env.VERCEL === '1' || has(env.VERCEL_ENV);
}

/** Vercel 위에서 실행 중(헤더 신뢰 경계가 Vercel 문서 기준). Cloud Run 표식이 함께 있으면 Vercel로 보지 않는다 */
export function onVercel(env: Env = process.env): boolean {
  return env.VERCEL === '1' && !has(env.K_SERVICE);
}

/** Cloud Run 위에서 실행 중 */
export function onCloudRun(env: Env = process.env): boolean {
  return has(env.K_SERVICE);
}

/**
 * 실제 운영을 '여는' 판정(실접수·검색 노출 등). 닫는 판정(isProduction)보다 좁다:
 * 운영 표식이 있어도 Vercel 검수·개발 배포 표식이 함께 있으면 열지 않는다(설정 실수로 검수 배포가 실고객을 받지 않게).
 */
export function isLiveProduction(env: Env = process.env): boolean {
  return isProduction(env) && env.VERCEL_ENV !== 'preview' && env.VERCEL_ENV !== 'development';
}
