import { isHostedDeploy, isProduction } from '../env/deployEnv';
/**
 * 관리자 인증 스위치(기본 꺼짐). 순수 함수: middleware·서버 화면·시험에서 함께 쓴다.
 * - ADMIN_AUTH_MODE=supabase 이고 필요한 서버 설정이 모두 있을 때만 켠다. 하나라도 비면 꺼진다.
 * - 운영(VERCEL_ENV=production)에서는 켜지 않는다. 운영 활성화는 PM·사용자 별도 승인 뒤 이 줄을 바꾼다.
 * - 꺼져 있으면 관리자 화면은 잠기고, 가상 데이터 화면은 로컬 개발 서버(next dev)에서만 보인다.
 */
export type AdminAuthMode = 'disabled' | 'supabase';

export const ADMIN_AUTH_REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'FIDEON_STAFF_SIGNING_KEY',
  'DATABASE_URL',
] as const;

type Env = Record<string, string | undefined>;

/**
 * DB 주소가 이 컴퓨터(localhost·127.0.0.1)인가. db/client.ts와 같은 판단을 쓴다.
 * 주소 해석에 실패하거나 호스트가 다르면 원격으로 본다(원격이면 CA 인증서 검증이 필요하므로 안전한 쪽).
 */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  try {
    const u = new URL((url ?? '').trim());
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function adminAuthMode(env: Env = process.env): AdminAuthMode {
  if (isProduction(env)) return 'disabled'; // 운영(Vercel·Cloud Run·APP_ENV) 자동 차단
  if (env.ADMIN_AUTH_MODE !== 'supabase') return 'disabled';
  if (!ADMIN_AUTH_REQUIRED_ENV.every((k) => (env[k] ?? '').trim() !== '')) return 'disabled';
  // 원격 DB는 CA 인증서가 없으면 db/client.ts가 접속을 거부한다. 켜진 척하지 않고 꺼서 관리자 화면·API를 잠금·503으로 닫는다
  if (!isLocalDatabaseUrl(env.DATABASE_URL) && (env.SUPABASE_DB_CA_CERT ?? '').trim() === '') return 'disabled';
  return 'supabase';
}

/** 인증이 꺼진 상태에서 가상 데이터 관리자 화면을 보여도 되는가: 로컬 개발 서버만 */
export function adminMockVisible(env: Env = process.env): boolean {
  return adminAuthMode(env) === 'disabled' && env.NODE_ENV === 'development' && !isHostedDeploy(env);
}
