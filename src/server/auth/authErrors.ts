// Supabase Auth 오류 분류(순수 함수). middleware·서버 클라이언트·시험이 함께 쓴다.

/** 인증 서버에 닿지 못한 오류인가(로그인 안 됨·토큰 무효와 구분). 판정이 불확실하면 장애로 본다. */
export function isAuthOutage(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; status?: unknown };
  if (e.name === 'AuthRetryableFetchError') return true;
  if (e.name === 'AuthSessionMissingError' || e.name === 'AuthInvalidJwtError') return false;
  return typeof e.status !== 'number' || e.status === 0 || e.status >= 500;
}

/** 인증 세션 조회 결과. 인증 서버 장애는 결과가 아니라 예외로 전달한다. */
export type SessionResult<C> = { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; claims: C };

/** getClaims 결과를 세션 없음 / 검증 실패 / 정상으로 나누고, 장애는 원문 없는 예외로 바꾼다. */
export function classifyClaims<C>(result: { data?: { claims?: unknown } | null; error?: unknown }): SessionResult<C> {
  const { data, error } = result;
  if (error) {
    if (isAuthOutage(error)) throw new Error('AUTH_UNAVAILABLE');
    return (error as { name?: unknown }).name === 'AuthSessionMissingError' ? { kind: 'none' } : { kind: 'invalid' };
  }
  return data?.claims ? { kind: 'ok', claims: data.claims as C } : { kind: 'none' };
}
