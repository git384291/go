import 'server-only';
import type postgres from 'postgres';
import type { SigningKey } from '../security/token';
import type { VerifiedClaims } from './staffAssertion';
import { withRole } from '../db/client';
import { authorizeStaffSession, establishStaffSession, revokeStaffSession, type StaffIdentity } from './staffSession';

/**
 * 관리자 세션의 DB 배선(SQL)만 모은 모듈. 쿠키·Supabase에 의존하지 않아
 * 통합 시험(tests/integration)이 실제 로컬 가상 PostgreSQL로 같은 코드를 실행한다.
 */
export type StaffTx = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => Promise<T>;

export const staffTx: StaffTx = (fn) => withRole('staff', fn);

/** 모든 관리자 요청: api.whoami로 직원·세션 유효성을 DB가 확인 */
export function authorizeStaffWithDb(claims: VerifiedClaims, key: SigningKey, run: StaffTx = staffTx): Promise<StaffIdentity> {
  return authorizeStaffSession(claims, key, (auth) =>
    run((tx) => tx`select * from api.whoami(${auth.actor}::uuid, ${auth.session}::uuid, ${auth.token})`),
  );
}

/** 로그인(비밀번호 + TOTP) 직후 1회: 등록과 확인을 한 트랜잭션에서 실행, 확인 실패 시 등록·감사 기록 롤백 */
export function openStaffSessionWithDb(claims: VerifiedClaims, key: SigningKey, run: StaffTx = staffTx): Promise<StaffIdentity> {
  return establishStaffSession(claims, key, (body) =>
    run((tx) => body({
      open: async (auth) => {
        await tx`select api.staff_session_open(${auth.actor}::uuid, ${auth.session}::uuid, ${auth.token})`;
      },
      whoami: (auth) => tx`select * from api.whoami(${auth.actor}::uuid, ${auth.session}::uuid, ${auth.token})`,
    })),
  );
}

/** 로그아웃: DB 세션 폐기 + 감사 기록 */
export function revokeStaffSessionWithDb(claims: VerifiedClaims, key: SigningKey, run: StaffTx = staffTx): Promise<void> {
  return revokeStaffSession(claims, key, (auth) =>
    run((tx) => tx`select api.staff_session_revoke(${auth.actor}::uuid, ${auth.session}::uuid, ${auth.token})`),
  );
}
