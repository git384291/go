import { signToken, type SigningKey } from '../security/token';

/**
 * 관리자 인증 결과 → DB 함수에 넘길 인증 정보.
 * REV-004 SEC-01:
 *  - 세션 ID 단독 인증 금지: (사용자 ID, 세션 ID)를 서버 키로 함께 서명한다.
 *  - 서버가 검증한 사용자와 DB가 확인하는 사용자가 같다: 서명 대상에 사용자 ID가 들어가고,
 *    DB는 자체 세션 테이블에서 그 세션의 소유자가 같은 사용자인지 다시 확인한다.
 *  - Supabase 내부 테이블(auth.sessions)에 의존하지 않는다: 토큰 클레임만 사용한다.
 */
export type VerifiedClaims = {
  sub?: unknown; // 사용자 ID
  session_id?: unknown;
  aal?: unknown;
};

export type StaffAuth = { actor: string; session: string; token: string };

export class StaffAuthError extends Error {
  constructor(public readonly status: 401 | 403, code: string) {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function idsFrom(claims: VerifiedClaims): { actor: string; session: string } {
  if (claims.aal !== 'aal2') throw new StaffAuthError(403, 'MFA_REQUIRED');
  if (typeof claims.sub !== 'string' || !UUID.test(claims.sub)) throw new StaffAuthError(401, 'NO_USER');
  if (typeof claims.session_id !== 'string' || !UUID.test(claims.session_id)) throw new StaffAuthError(401, 'NO_SESSION');
  return { actor: claims.sub.toLowerCase(), session: claims.session_id.toLowerCase() };
}

/** 모든 관리자 요청: DB의 security.assert_staff가 검증 */
export function staffAssertion(claims: VerifiedClaims, key: SigningKey, nowSeconds?: number): StaffAuth {
  const { actor, session } = idsFrom(claims);
  return { actor, session, token: signToken('staff', [actor, session], key, nowSeconds) };
}

/** 로그인 직후 1회: DB의 api.staff_session_open이 검증. 일반 요청 토큰과 서명 대상이 다르다 */
export function staffSessionOpenAssertion(claims: VerifiedClaims, key: SigningKey, nowSeconds?: number): StaffAuth {
  const { actor, session } = idsFrom(claims);
  return { actor, session, token: signToken('staff', ['session-open', actor, session, 'aal2'], key, nowSeconds) };
}
