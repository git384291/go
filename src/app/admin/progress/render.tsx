import type { ReactElement } from 'react';
import { progressAccess } from '@/server/admin/progressAccess';
import type { AdminAuthMode } from '@/server/auth/adminAuthMode';
import type { StaffIdentity } from '@/server/auth/staffSession';
import type { ProgressSnapshot } from '@/content/progress';
import { ProgressLocked, ProgressView } from './ProgressView';

/**
 * 진행판 응답 결정(시험용으로 분리). 스냅샷은 owner 판정 뒤에만 불러온다(loadSnapshot).
 * 거부 결과의 요소 트리에는 스냅샷이 들어가지 않는다 → HTML·RSC 응답에도 직렬화되지 않는다.
 */
export async function renderProgress(deps: {
  mode: () => AdminAuthMode;
  requireStaff: () => Promise<StaffIdentity>;
  loadSnapshot: () => Promise<ProgressSnapshot>;
  now: () => Date;
}): Promise<{ redirect: '/admin/login' } | { element: ReactElement }> {
  const access = await progressAccess(deps);
  if (access === 'login') return { redirect: '/admin/login' };
  if (access !== 'owner') return { element: <ProgressLocked kind={access} /> };
  return { element: <ProgressView snapshot={await deps.loadSnapshot()} now={deps.now()} /> };
}
