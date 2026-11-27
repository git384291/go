import type { VerifiedClaims } from './staffAssertion';
import { StaffAuthError } from './staffAssertion';
import type { SessionResult } from './authErrors';
import type { LoginError, LoginState, LogoutOutcome } from '../../content/adminLogin';

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
  /** 서명 검증된 세션 조회: none(세션 없음) / invalid(검증 실패) / ok. 인증 서버 장애는 예외 */
  session: () => Promise<SessionResult<VerifiedClaims>>;
  /** Supabase 로그아웃. SDK가 오류를 돌려주면 예외(원문 오류는 담지 않음) */
  signOut: () => Promise<void>;
  /** 이 브라우저의 Supabase 인증 쿠키를 직접 지운다(로그아웃 API 실패 시 대비) */
  clearLocalSession: () => Promise<void>;
};

export type { LoginError, LoginState, LogoutOutcome };

/** 로그인 경로용: 정상 세션의 클레임만, 그 외(없음·무효·장애)는 null */
async function claimsOf(port: AuthPort): Promise<VerifiedClaims | null> {
  try {
    const r = await port.session();
    return r.kind === 'ok' ? r.claims : null;
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Supabase 로그아웃 → 실패하면 로컬 인증 쿠키 직접 삭제. 원문 오류는 버린다. */
async function endAuth(port: AuthPort): Promise<{ signedOut: boolean; localCleared: boolean }> {
  try {
    await port.signOut();
    return { signedOut: true, localCleared: true };
  } catch {
    try {
      await port.clearLocalSession();
      return { signedOut: false, localCleared: true };
    } catch {
      return { signedOut: false, localCleared: false };
    }
  }
}

async function quietSignOut(port: AuthPort) {
  await endAuth(port); // 로그인 실패 경로: 결과와 무관하게 로그인 성공으로 바꾸지 않는다
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
  const before = await claimsOf(port);
  if (!before) return { step: 'password', error: 'SESSION_EXPIRED' };
  const factorId = await port.verifiedTotpFactorId().catch(() => null);
  if (!factorId) {
    await quietSignOut(port);
    return { step: 'password', error: 'INVALID_CREDENTIALS' };
  }
  if (!(await port.challengeAndVerify(factorId, code).catch(() => false))) return { step: 'totp', error: 'INVALID_CODE' };
  const claims = await claimsOf(port);
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

/**
 * 로그아웃: DB 세션 폐기 → Supabase 로그아웃(실패 시 로컬 쿠키 삭제).
 * 결과를 숨기지 않는다. 'complete'가 아니면 화면이 로그아웃 완료로 보이지 않게 한다.
 * - DB 폐기 확인 = 세션 조회가 정상(ok)이고 revoke가 성공한 경우뿐.
 *   세션 없음(none)만 '폐기할 세션 없음'으로 본다. 검증 실패·조회 장애·예외는 폐기 미확인.
 * - 쿠키 삭제는 이 브라우저의 연결만 끝낸다. 이미 복사된 접근 토큰이나 DB 세션이 즉시 무효화됐다고 보장하지 않는다.
 * - DB 폐기를 확인 못 하면 DB 세션은 최대 12시간 뒤 만료된다(그 전에 같은 토큰을 가진 사람은 접근 가능).
 */
export async function logoutFlow(port: AuthPort, revoke: (claims: VerifiedClaims) => Promise<void>): Promise<LogoutOutcome> {
  let dbOk: boolean;
  try {
    const s = await port.session();
    if (s.kind === 'ok') {
      try { await revoke(s.claims); dbOk = true; } catch { dbOk = false; }
    } else {
      dbOk = s.kind === 'none';
    }
  } catch {
    dbOk = false; // 인증 서버 장애: 세션 존재 여부를 모른다
  }
  const auth = await endAuth(port);
  if (!auth.localCleared) return 'local_not_cleared';
  if (!dbOk && !auth.signedOut) return 'both_unconfirmed';
  if (!dbOk) return 'db_unconfirmed';
  if (!auth.signedOut) return 'auth_unconfirmed';
  return 'complete';
}
