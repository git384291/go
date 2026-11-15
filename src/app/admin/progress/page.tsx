import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { renderProgress } from './render';

// 대표 전용 진행판. 새 API 없음(서버 컴포넌트). 검색 제외는 인증을 대신하지 않는다.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '진행 상황', robots: { index: false, follow: false, nocache: true } };

export default async function ProgressPage() {
  const result = await renderProgress({
    mode: () => adminAuthMode(),
    requireStaff,
    loadSnapshot: async () => (await import('@/server/admin/progressSnapshot')).PROGRESS_SNAPSHOT,
    now: () => new Date(),
  });
  if ('redirect' in result) redirect(result.redirect);
  return result.element;
}
