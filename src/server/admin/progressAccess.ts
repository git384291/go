import type { AdminAuthMode } from '../auth/adminAuthMode';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';

/**
 * 진행판 접근 판정. 대표(owner)만 허용한다.
 * - 인증 꺼짐: 잠금(로컬 개발 서버의 가상 화면 우회도 없음). requireStaff를 호출하지 않는다.
 * - 미인증(401): 로그인 화면으로. 권한 없음·다른 역할: 거부. 인증·DB 장애: 일시 불가.
 */
export type ProgressAccess = 'owner' | 'locked' | 'login' | 'forbidden' | 'unavailable';

export async function progressAccess(deps: { mode: () => AdminAuthMode; requireStaff: () => Promise<StaffIdentity> }): Promise<ProgressAccess> {
  if (deps.mode() !== 'supabase') return 'locked';
  let who: StaffIdentity;
  try {
    who = await deps.requireStaff();
  } catch (error) {
    if (error instanceof StaffAuthError) return error.status === 401 ? 'login' : 'forbidden';
    return 'unavailable';
  }
  return who.role === 'owner' ? 'owner' : 'forbidden';
}
