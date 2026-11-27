import type { Metadata } from 'next';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import type { CrmAdminDeps, SqlTag } from '@/server/admin/crmAdmin';
import { contractList, type ContractItem } from '@/server/admin/contractAdmin';
import { withRole } from '@/server/db/client';
import { ContractsLocked, ContractsView } from './ContractsView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '설치·정산·환수', robots: { index: false, follow: false, nocache: true } };

const deps = (): CrmAdminDeps => ({
  env: () => process.env,
  mode: () => adminAuthMode(),
  requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)),
  now: () => new Date(),
});

export default async function ContractsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const res = await contractList(deps(), new Request('http://internal/api/admin/contracts?filter=all'));
  if (res.status === 401) {
    const { redirect } = await import('next/navigation');
    return redirect('/admin/login');
  }
  if (res.status === 403) return <ContractsLocked text="대표 계정만 볼 수 있습니다." />;
  if (res.status !== 200) return <ContractsLocked text="설치·정산 화면을 열 수 없습니다. 운영 DB 설정을 확인해 주세요." />;
  const body = (await res.json()) as { items: ContractItem[]; risk: number };
  const p = await searchParams;
  const leadId = typeof p.leadId === 'string' ? p.leadId : '';
  return <ContractsView items={body.items} risk={body.risk} initialLeadId={leadId} />;
}
