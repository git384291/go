import type { Metadata } from 'next';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { aiBudgetGet } from '@/server/admin/aiBudget';
import type { SqlTag } from '@/server/admin/adBudget';
import { withRole } from '@/server/db/client';
import { AiBudgetLocked, AiBudgetView, type AiBudgetData } from './AiBudgetView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'AI 비용 한도', robots: { index: false, follow: false, nocache: true } };

export default async function AiBudgetPage() {
  const res = await aiBudgetGet({
    env: () => process.env, mode: () => adminAuthMode(), requireStaff,
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
  });
  if (res.status === 401) {
    const { redirect } = await import('next/navigation');
    return redirect('/admin/login');
  }
  if (res.status === 403) return <AiBudgetLocked kind="forbidden" />;
  if (res.status === 503) return <AiBudgetLocked kind="disabled" />;
  if (res.status !== 200) return <AiBudgetLocked kind="failed" />;
  return <AiBudgetView data={(await res.json()) as AiBudgetData} />;
}
