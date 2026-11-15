// 관리자 로그인 UI. 1단계: 이메일+비밀번호 → TOTP 6자리(2단계 인증) → 서버가 aal2 확인 후 DB 세션 열기.
// 인증 스위치(ADMIN_AUTH_MODE)가 꺼져 있으면 입력이 막힌 미리보기 화면만 보인다.
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { logoutNotice } from '@/content/adminLogin';
import { LoginForm } from './LoginForm';
import { LoginPreview } from './LoginPreview';

export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminLoginPage({ searchParams }: Props) {
  if (adminAuthMode() === 'supabase') {
    // 로그아웃이 완전히 끝나지 않았으면 완료처럼 보이지 않게 경고한다(정해진 문구만 표시).
    const notice = logoutNotice((await searchParams).logout);
    return (
      <main className="login">
        <div className="login-card">
          <span className="brand"><span className="brand-mark" aria-hidden="true" />FIDEON</span>
          <h1>관리자 로그인</h1>
          {notice && <p className="form-error" role="alert">{notice}</p>}
          <LoginForm />
        </div>
      </main>
    );
  }
  return <LoginPreview />;
}
