import { redirect } from 'next/navigation';
import { adminAuthMode, adminMockVisible } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { AdminMockView } from './AdminMockView';
import { logoutAction } from './actions';

// 환경변수를 요청 시점에 읽고, 관리자 화면을 캐시하지 않는다.
export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = { owner: '대표', counselor: '상담', policy_editor: '정책 편집', reviewer: '검수' };

export default async function AdminPage() {
  if (adminAuthMode() === 'disabled') {
    // 인증이 꺼져 있으면 잠근다. 가상 데이터 화면은 로컬 개발 서버(next dev)에서만.
    if (!adminMockVisible()) return <main className="admin-locked">관리자 화면은 인증 연결 후 열립니다.</main>;
    return <AdminMockView />;
  }
  // 모든 요청에서 DB가 직원·세션 유효성을 확인한다(aal2 쿠키만으로 통과하지 않음).
  let role: string | null = null;
  try {
    role = (await requireStaff()).role;
  } catch {
    role = null; // 401·403·DB 장애 모두 로그인 화면으로(사유는 노출하지 않음)
  }
  if (!role) redirect('/admin/login');
  return (
    <AdminMockView
      headerExtra={
        <form action={logoutAction} className="admin-logout">
          {role === 'owner' && <a className="admin-link" href="/admin/progress">진행 상황</a>}
          <span className="admin-role">{ROLE_LABEL[role] ?? role}</span>
          <button className="btn btn-ghost" type="submit">로그아웃</button>
        </form>
      }
    />
  );
}
