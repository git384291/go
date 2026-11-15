import 'server-only';
import { signingKeyFromEnv } from '../security/token';
import { StaffAuthError } from './staffAssertion';
import type { StaffIdentity } from './staffSession';
import { authorizeStaffWithDb, openStaffSessionWithDb } from './staffSessionDb';
import { supabaseServer, verifiedClaimsFrom } from './supabaseServer';

async function verifiedClaims() {
  const claims = await verifiedClaimsFrom(await supabaseServer());
  if (!claims) throw new StaffAuthError(401, 'UNAUTHENTICATED');
  return claims;
}

/** 관리자 화면·Server Action·Route Handler 첫 줄에서 호출. 역할 판정은 DB 함수가 한다. */
export async function requireStaff(): Promise<StaffIdentity> {
  return authorizeStaffWithDb(await verifiedClaims(), signingKeyFromEnv('staff'));
}

/** 로그인(비밀번호 + TOTP) 완료 직후 1회 호출해 DB 자체 세션을 연다 */
export async function openStaffSession(): Promise<string> {
  const identity = await openStaffSessionWithDb(await verifiedClaims(), signingKeyFromEnv('staff'));
  return identity.role;
}
