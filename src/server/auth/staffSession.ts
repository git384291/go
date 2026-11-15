import { staffAssertion, staffSessionOpenAssertion, StaffAuthError, type StaffAuth, type VerifiedClaims } from './staffAssertion';
import type { SigningKey } from '../security/token';

const STAFF_ROLES = ['owner', 'counselor', 'policy_editor', 'reviewer'] as const;
export type StaffRole = typeof STAFF_ROLES[number];
export type StaffIdentity = StaffAuth & { role: StaffRole };

export class StaffSessionUnavailable extends Error {
  constructor() {
    super('STAFF_SESSION_UNAVAILABLE');
    this.name = 'StaffSessionUnavailable';
  }
}

export type StaffSessionStore = {
  open: (auth: StaffAuth) => Promise<void>;
  whoami: (auth: StaffAuth) => Promise<unknown>;
};

function identity(auth: StaffAuth, rows: unknown): StaffIdentity {
  if (!Array.isArray(rows) || rows.length !== 1) throw new StaffAuthError(403, 'FORBIDDEN');
  const row = rows[0] as { user_id?: unknown; role?: unknown } | null;
  if (!row || row.user_id !== auth.actor || !STAFF_ROLES.some((role) => role === row.role)) {
    throw new StaffAuthError(403, 'FORBIDDEN');
  }
  return { ...auth, role: row.role as StaffRole };
}

async function databaseCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StaffAuthError) throw error;
    // DB 권한 거부의 내부 SQL 메시지는 호출자에게 전달하지 않는다.
    if (error && typeof error === 'object' && 'code' in error && error.code === '42501') {
      throw new StaffAuthError(403, 'FORBIDDEN');
    }
    // DB 오류 객체의 쿼리·서명 파라미터·접속 정보가 로그나 응답으로 전파되지 않게 한다.
    throw new StaffSessionUnavailable();
  }
}

/** JWT의 aal2만으로 허용하지 않고 DB의 유효한 직원·세션 확인을 요구한다. */
export async function authorizeStaffSession(
  claims: VerifiedClaims,
  key: SigningKey,
  whoami: StaffSessionStore['whoami'],
): Promise<StaffIdentity> {
  const auth = staffAssertion(claims, key);
  return identity(auth, await databaseCall(() => whoami(auth)));
}

/** 등록과 유효성 확인은 같은 DB 트랜잭션에서 실행하고 거부 시 모두 롤백한다. */
export async function establishStaffSession(
  claims: VerifiedClaims,
  key: SigningKey,
  transaction: (run: (store: StaffSessionStore) => Promise<StaffIdentity>) => Promise<StaffIdentity>,
): Promise<StaffIdentity> {
  // DB에 연결하기 전에 검증된 클레임의 사용자·세션·aal2를 검사한다.
  const opening = staffSessionOpenAssertion(claims, key);
  const auth = staffAssertion(claims, key);
  return databaseCall(() => transaction(async (store) => {
    await store.open(opening);
    return identity(auth, await store.whoami(auth));
  }));
}
