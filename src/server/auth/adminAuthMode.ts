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

export function adminAuthMode(env: Env = process.env): AdminAuthMode {
  if (env.VERCEL_ENV === 'production') return 'disabled';
  if (env.ADMIN_AUTH_MODE !== 'supabase') return 'disabled';
  return ADMIN_AUTH_REQUIRED_ENV.every((k) => (env[k] ?? '').trim() !== '') ? 'supabase' : 'disabled';
}

/** 인증이 꺼진 상태에서 가상 데이터 관리자 화면을 보여도 되는가: 로컬 개발 서버만 */
export function adminMockVisible(env: Env = process.env): boolean {
  return adminAuthMode(env) === 'disabled' && env.NODE_ENV === 'development' && env.VERCEL !== '1';
}
