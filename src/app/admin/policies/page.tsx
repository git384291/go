import type { Metadata } from 'next';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { listPolicies, type PolicyAdminDeps, type SqlTag } from '@/server/admin/policyAdmin';
import { withRole } from '@/server/db/client';
import { PolicyAdminView, PolicyLocked, type PolicyRow } from './PolicyAdminView';

// 관리자 정책 화면. 서버 컴포넌트가 같은 서버 모듈(listPolicies)을 호출하므로 게이트·역할·DB 판정이 API와 동일하다.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '정책 관리', robots: { index: false, follow: false, nocache: true } };

export default async function PoliciesPage() {
  const deps: PolicyAdminDeps = {
    env: () => process.env, mode: () => adminAuthMode(), requireStaff,
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
  };
  const res = await listPolicies(deps, new Request('http://internal/api/admin/policies?limit=100'));
  if (res.status === 401) {
    const { redirect } = await import('next/navigation');
    return redirect('/admin/login');
  }
  if (res.status === 403) return <PolicyLocked kind="forbidden" />;
  if (res.status === 503) return <PolicyLocked kind="disabled" />;
  if (res.status !== 200) return <PolicyLocked kind="failed" />;
  const body = (await res.json()) as { role: string; items: PolicyRow[] };
  return <PolicyAdminView items={body.items} role={body.role} publishOn={false} />;
}
