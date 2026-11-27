import type { Metadata } from 'next';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { adBudgetOverview, type AdBudgetDeps, type SqlTag } from '@/server/admin/adBudget';
import { withRole } from '@/server/db/client';
import { AdBudgetLocked, AdBudgetView, type BudgetRow } from './AdBudgetView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '광고 예산', robots: { index: false, follow: false, nocache: true } };

export default async function AdsPage() {
  const deps: AdBudgetDeps = {
    env: () => process.env, mode: () => adminAuthMode(), requireStaff,
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
  };
  const res = await adBudgetOverview(deps, new Request('http://internal/api/admin/ads/budget?limit=100'));
  if (res.status === 401) {
    const { redirect } = await import('next/navigation');
    return redirect('/admin/login');
  }
  if (res.status === 403) return <AdBudgetLocked kind="forbidden" />;
  if (res.status === 503) return <AdBudgetLocked kind="disabled" />;
  if (res.status !== 200) return <AdBudgetLocked kind="failed" />;
  const body = (await res.json()) as { role: string; caps: { dailyKrw: number; totalKrw: number }; items: BudgetRow[] };
  return <AdBudgetView items={body.items} role={body.role} caps={body.caps} />;
}
