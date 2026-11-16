import 'server-only';

/**
 * Turnstile 서버 확인. 결과는 세 가지뿐이다.
 * - 'ok': 성공 + action === 'lead_form' + hostname === PUBLIC_HOSTNAME
 * - 'rejected': 토큰 없음·형식 밖·비밀 키 없음·확인 실패·action/hostname 불일치
 * - 'unavailable': 네트워크 실패·시간 초과·HTTP 오류·비JSON·형태가 틀린 응답(외부 확인을 못 함)
 * 어느 쪽이든 'ok'가 아니면 호출자는 저장으로 진행하지 않는다. 예외를 밖으로 던지지 않는다.
 * 토큰·비밀 키·응답 원문은 로그에 남기지 않는다.
 */
export type TurnstileResult = 'ok' | 'rejected' | 'unavailable';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = 5000;

export async function verifyTurnstile(token: string, ip: string): Promise<TurnstileResult> {
  if (!token || token.length > 2048) return 'rejected';
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return 'rejected';
  const expectedHost = process.env.PUBLIC_HOSTNAME;

  let res: Response;
  try {
    res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    return 'unavailable';
  }
  if (!res.ok) return 'unavailable';

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return 'unavailable';
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'unavailable';
  const d = data as { success?: unknown; action?: unknown; hostname?: unknown };
  if (typeof d.success !== 'boolean') return 'unavailable';
  if (d.success !== true) return 'rejected';
  return d.action === 'lead_form' && typeof d.hostname === 'string' && !!expectedHost && d.hostname === expectedHost
    ? 'ok'
    : 'rejected';
}
