import type { Metadata } from 'next';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { gate, type CrmAdminDeps, type SqlTag } from '@/server/admin/crmAdmin';
import { withRole } from '@/server/db/client';
import { NaverImportConsole } from './NaverImportConsole';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '네이버 접수 가져오기', robots: { index: false, follow: false, nocache: true } };
const deps = (): CrmAdminDeps => ({
  env: () => process.env, mode: () => adminAuthMode(), requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
});

export default async function NaverImportPage() {
  const allowed = await gate(deps());
  if (allowed instanceof Response) {
    if (allowed.status === 401) { const { redirect } = await import('next/navigation'); return redirect('/admin/login'); }
    return <main className="admin-locked" role="status">대표 계정과 운영 DB 연결이 필요합니다.</main>;
  }
  return (
    <div className="admin">
      <header className="admin-bar"><span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />바른365 관리 · 네이버 접수</span><a className="admin-link" href="/admin">상담 목록</a></header>
      <main className="admin-main"><NaverImportConsole /></main>
    </div>
  );
}
