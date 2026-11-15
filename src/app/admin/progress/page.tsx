import type { Metadata } from 'next';
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
  if ('redirect' in result) {
    // 필요할 때만 불러온다(거부·잠금 경로 시험이 next 클라이언트 모듈 없이 실제 page를 실행할 수 있게)
    const { redirect } = await import('next/navigation');
    redirect(result.redirect);
  }
  return result.element;
}
