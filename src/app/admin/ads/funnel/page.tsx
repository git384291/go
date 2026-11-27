import type { Metadata } from 'next';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { adFunnel } from '@/server/admin/adRun';
import type { SqlTag } from '@/server/admin/adBudget';
import { withRole } from '@/server/db/client';
import { FunnelLocked, FunnelView, type AlertRow, type FunnelItem } from './FunnelView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '광고 성과', robots: { index: false, follow: false, nocache: true } };

export default async function FunnelPage() {
  const res = await adFunnel({
    env: () => process.env, mode: () => adminAuthMode(), requireStaff,
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
  }, new Request('http://internal/api/admin/ads/funnel'));
  if (res.status === 401) {
    const { redirect } = await import('next/navigation');
    return redirect('/admin/login');
  }
  if (res.status === 403) return <FunnelLocked kind="forbidden" />;
  if (res.status === 503) return <FunnelLocked kind="disabled" />;
  if (res.status !== 200) return <FunnelLocked kind="failed" />;
  const b = (await res.json()) as { role: string; from: string; to: string; items: FunnelItem[]; alerts: AlertRow[]; alertsError: boolean };
  return <FunnelView items={b.items} role={b.role} from={b.from} to={b.to} alerts={b.alerts} alertsError={b.alertsError} />;
}
