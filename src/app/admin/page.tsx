import type { Metadata } from 'next';
import { adminMockVisible } from '@/server/auth/adminAuthMode';
import { defaultLeadsServerDeps } from '@/server/admin/leadsDefaults';
import { AdminMockView } from './AdminMockView';
import { logoutAction } from './actions';
import { renderAdminLeads } from './leadsRender';

// 환경변수를 요청 시점에 읽고, 관리자 화면을 캐시하지 않는다. 검색 제외는 인증을 대신하지 않는다.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '관리', robots: { index: false, follow: false, nocache: true } };

const ROLE_LABEL: Record<string, string> = { owner: '대표', counselor: '상담', policy_editor: '정책 편집', reviewer: '검수' };

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // 모든 요청에서 DB가 직원·세션 유효성을 확인한다(aal2 쿠키만으로 통과하지 않음). 출처 분기는 leadsRender.tsx
  const result = await renderAdminLeads({
    ...defaultLeadsServerDeps(),
    mockVisible: () => adminMockVisible(),
    searchParams: await searchParams,
    headerExtra: (role) => (
      <form action={logoutAction} className="admin-logout">
        {role === 'owner' && <><a className="admin-link" href="/admin/intake/naver">네이버 접수</a><a className="admin-link" href="/admin/contracts">설치·정산</a><a className="admin-link" href="/admin/progress">진행 상황</a></>}
        <span className="admin-role">{ROLE_LABEL[role] ?? role}</span>
        <button className="btn btn-ghost" type="submit">로그아웃</button>
      </form>
    ),
    mockView: (headerExtra) => <AdminMockView headerExtra={headerExtra} />,
  });
  if ('redirect' in result) {
    const { redirect } = await import('next/navigation');
    return redirect(result.redirect);
  }
  return result.element;
}
