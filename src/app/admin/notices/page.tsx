import type { Metadata } from 'next';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { noticeList, type PolicyAdminDeps, type SqlTag } from '@/server/admin/policyAdmin';
import { withRole } from '@/server/db/client';
import { REQUIRED_NOTICES, compareNoticeTexts, noticeReadiness } from '@/content/requiredNotices';
import { NoticesLocked, NoticesView, type NoticeRow } from './NoticesView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '필수 고지', robots: { index: false, follow: false, nocache: true } };

export default async function NoticesPage() {
  const deps: PolicyAdminDeps = {
    env: () => process.env, mode: () => adminAuthMode(), requireStaff,
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
  };
  const res = await noticeList(deps);
  if (res.status === 401) {
    const { redirect } = await import('next/navigation');
    return redirect('/admin/login');
  }
  if (res.status === 403) return <NoticesLocked kind="forbidden" />;
  if (res.status === 503) return <NoticesLocked kind="disabled" />;
  if (res.status !== 200) return <NoticesLocked kind="failed" />;
  const body = (await res.json()) as { role: string; items: NoticeRow[] };
  const r = noticeReadiness(REQUIRED_NOTICES, (process.env.PRIVACY_POLICY_VERSION ?? '').trim());
  const mismatches = REQUIRED_NOTICES.version === '' ? [] : compareNoticeTexts(REQUIRED_NOTICES, body.items);
  return <NoticesView rows={body.items} role={body.role} status={{ ready: r.ready && mismatches.length === 0, reason: r.ready ? null : r.reason, codeVersion: REQUIRED_NOTICES.version, mismatches }} />;
}
