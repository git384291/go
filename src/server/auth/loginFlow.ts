import type { VerifiedClaims } from './staffAssertion';
import { StaffAuthError } from './staffAssertion';
import type { LoginError, LoginState } from '../../content/adminLogin';

/**
 * 관리자 로그인 절차(비밀번호 → TOTP → DB 세션). Supabase·쿠키는 AuthPort로 주입해 시험한다.
 * 원칙
 * - 오류 응답은 계정 존재 여부·비밀번호 정답 여부를 드러내지 않는다(미등록·TOTP 미등록·비밀번호 오류 모두 같은 코드).
 * - aal2(TOTP 확인) 전에는 DB 세션을 열지 않는다. TOTP 성공 후 정확히 1회 연다.
 * - TOTP 최초 등록은 이 화면에서 하지 않는다(대표 입회 절차로 별도 진행 — 비밀번호만 아는 사람의 선등록 방지).
 * - DB가 거부하거나 장애면 Supabase 로그인도 끝낸다(반쯤 로그인된 상태를 남기지 않음).
 */
export type AuthPort = {
  signInWithPassword: (email: string, password: string) => Promise<boolean>;
  /** 다음 단계로 aal2가 가능한지(검증된 TOTP가 있는지) */
  nextLevel: () => Promise<string | null>;
  verifiedTotpFactorId: () => Promise<string | null>;
  challengeAndVerify: (factorId: string, code: string) => Promise<boolean>;
  /** 서명 검증된 접근 토큰 클레임. 로그인 안 됨이면 null */
  claims: () => Promise<VerifiedClaims | null>;
  signOut: () => Promise<void>;
};

export type { LoginError, LoginState };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

async function quietSignOut(port: AuthPort) {
  try { await port.signOut(); } catch { /* 로그아웃 실패도 로그인 성공으로 바꾸지 않는다 */ }
}

export async function passwordStep(input: { email: unknown; password: unknown }, port: AuthPort): Promise<LoginState> {
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!EMAIL.test(email) || password.length < 1 || password.length > 256) return { step: 'password', error: 'INVALID_CREDENTIALS' };
  let ok = false;
  try { ok = await port.signInWithPassword(email, password); } catch { return { step: 'password', error: 'UNAVAILABLE' }; }
  if (!ok) return { step: 'password', error: 'INVALID_CREDENTIALS' };
  // TOTP 미등록 계정은 비밀번호만으로 들어올 수 없다. 응답은 비밀번호 오류와 같게 한다.
  if ((await port.nextLevel().catch(() => null)) !== 'aal2') {
    await quietSignOut(port);
    return { step: 'password', error: 'INVALID_CREDENTIALS' };
  }
  return { step: 'totp' };
}

export async function totpStep(
  input: { code: unknown },
  port: AuthPort,
  openSession: (claims: VerifiedClaims) => Promise<string>,
): Promise<LoginState> {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return { step: 'totp', error: 'INVALID_CODE' };
  const before = await port.claims().catch(() => null);
  if (!before) return { step: 'password', error: 'SESSION_EXPIRED' };
  const factorId = await port.verifiedTotpFactorId().catch(() => null);
  if (!factorId) {
    await quietSignOut(port);
    return { step: 'password', error: 'INVALID_CREDENTIALS' };
  }
  if (!(await port.challengeAndVerify(factorId, code).catch(() => false))) return { step: 'totp', error: 'INVALID_CODE' };
  const claims = await port.claims().catch(() => null);
  if (!claims || claims.aal !== 'aal2') {
    await quietSignOut(port);
    return { step: 'password', error: 'SESSION_EXPIRED' };
  }
  try {
    return { step: 'done', role: await openSession(claims) };
  } catch (error) {
    await quietSignOut(port);
    return { step: 'password', error: error instanceof StaffAuthError ? 'ACCESS_DENIED' : 'UNAVAILABLE' };
  }
}

/** 로그아웃: DB 세션 폐기(실패해도 진행) → Supabase 로그아웃 */
export async function logoutFlow(port: AuthPort, revoke: (claims: VerifiedClaims) => Promise<void>): Promise<void> {
  const claims = await port.claims().catch(() => null);
  if (claims) {
    try { await revoke(claims); } catch { /* 이미 폐기·만료여도 로그아웃은 끝까지 진행 */ }
  }
  await quietSignOut(port);
}
