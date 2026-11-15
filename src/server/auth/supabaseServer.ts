import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { AuthPort } from './loginFlow';
import type { VerifiedClaims } from './staffAssertion';
import { classifyClaims, type SessionResult } from './authErrors';

/**
 * 요청 쿠키 기반 Supabase 서버 클라이언트.
 * Server Component에서는 Next 15가 쿠키 쓰기를 막는다(예외). 그 경우 쓰기를 건너뛰고,
 * 토큰 갱신 쿠키는 src/middleware.ts가 같은 요청 앞단에서 기록한다(@supabase/ssr 권장 구조).
 * Server Action·Route Handler에서는 쓰기가 정상 동작한다.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          try {
            for (const { name, value, options } of list) cookieStore.set(name, value, options);
          } catch {
            // Server Component 렌더링 중: middleware가 갱신을 담당한다.
          }
        },
      },
    },
  );
}

type Supabase = Awaited<ReturnType<typeof supabaseServer>>;

/** 서명 검증된 세션 조회. 장애(예외·재시도 오류·5xx)는 원문 없는 예외 AUTH_UNAVAILABLE */
export async function sessionFrom(supabase: Supabase): Promise<SessionResult<VerifiedClaims>> {
  let result: Awaited<ReturnType<Supabase['auth']['getClaims']>>;
  try {
    result = await supabase.auth.getClaims();
  } catch {
    throw new Error('AUTH_UNAVAILABLE');
  }
  return classifyClaims<VerifiedClaims>(result);
}

/** 서명 검증된 클레임만 사용한다(쿠키 내용을 그대로 믿지 않음). 세션 없음·무효는 null, 장애는 예외 */
export async function verifiedClaimsFrom(supabase: Supabase): Promise<VerifiedClaims | null> {
  const r = await sessionFrom(supabase);
  return r.kind === 'ok' ? r.claims : null;
}

/** loginFlow.ts가 쓰는 최소 기능만 Supabase에 연결한다 */
export function authPort(supabase: Supabase): AuthPort {
  return {
    signInWithPassword: async (email, password) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      return !error && !!data.session;
    },
    nextLevel: async () => {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      return error ? null : data.nextLevel;
    },
    verifiedTotpFactorId: async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return null;
      return data.totp.find((f) => f.status === 'verified')?.id ?? null;
    },
    challengeAndVerify: async (factorId, code) => {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      return !error;
    },
    session: () => sessionFrom(supabase),
    signOut: async () => {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw new Error('AUTH_SIGNOUT_FAILED'); // SDK 원문 오류·토큰은 싣지 않는다
    },
    clearLocalSession: clearSupabaseCookies,
  };
}

/** Supabase 인증 쿠키(sb-<프로젝트>-auth-token, 분할 조각, PKCE 검증값)를 지운다. Server Action에서만 동작. */
export async function clearSupabaseCookies(): Promise<void> {
  const store = await cookies();
  for (const { name } of store.getAll()) {
    if (/^sb-[A-Za-z0-9-]+-auth-token(-code-verifier)?(\.\d+)?$/.test(name)) store.delete(name);
  }
}
