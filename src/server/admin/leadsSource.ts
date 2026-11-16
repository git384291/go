import 'server-only';

/**
 * 관리자 리드 데이터 출처 판정 (PM 6913462268). 순수 함수 — 환경 객체를 인자로 받는다.
 * - ADMIN_LEADS_SOURCE 미설정 또는 정확히 'mock' → 'mock'(기존 가상 동작, 기본값)
 * - 정확히 'db' → 'db'
 * - 그 밖의 값(대소문자·공백 포함) → 'invalid'(503으로 닫음)
 *
 * db 읽기 준비(dbReadReady)는 이번 단계에서 **개발·시험의 지정된 로컬 가상 DB만** 허용한다.
 * - NODE_ENV가 정확히 development·test일 때만 허용한다(next start·자체 호스팅 production 포함 그 밖은 거부, PM 6915073739).
 * - Vercel 배포 환경(production·preview, VERCEL=1)은 거부한다(mock으로 대체하지 않고 호출자가 503으로 닫음).
 * - DATABASE_URL: postgres:/postgresql: + loopback(localhost·127.0.0.1) + 폐기 시험 DB 이름(fideon_lrs_<pid>_<8hex>)만.
 *   원격 호스트·일반 DB 이름·잘못된 URL·쿼리 문자열은 거부한다. 판정에 쓴 URL은 로그·응답에 넣지 않는다.
 * 실제 운영 DB 읽기는 별도 승인 때 이 판정을 바꾼다.
 */
export type LeadsSource = 'mock' | 'db' | 'invalid';
type Env = Readonly<Record<string, string | undefined>>;

export function leadsSource(env: Env): LeadsSource {
  const v = env.ADMIN_LEADS_SOURCE;
  if (v === undefined || v === '' || v === 'mock') return 'mock';
  if (v === 'db') return 'db';
  return 'invalid';
}

const DISPOSABLE_DB_RE = /^\/fideon_lrs_\d{1,10}_[0-9a-f]{8}$/;

export function dbReadReady(env: Env): boolean {
  if (leadsSource(env) !== 'db') return false;
  // 개발·시험 프로세스만: NODE_ENV가 정확히 development·test가 아니면(production·미설정·빈 값·알 수 없는 값) 거부
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') return false;
  if (env.VERCEL === '1' || env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview') return false;
  const raw = env.DATABASE_URL;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return false;
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
  if (u.search !== '' || u.hash !== '') return false;
  return DISPOSABLE_DB_RE.test(u.pathname);
}
