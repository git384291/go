// 관리자 로그인 UI. 1단계: 이메일+비밀번호 → TOTP 6자리(2단계 인증) → 서버가 aal2 확인 후 DB 세션 열기.
// 인증 스위치(ADMIN_AUTH_MODE)가 꺼져 있으면 입력이 막힌 미리보기 화면만 보인다.
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { LoginForm } from './LoginForm';
import { LoginPreview } from './LoginPreview';

export const dynamic = 'force-dynamic';

export default function AdminLoginPage() {
  if (adminAuthMode() === 'supabase') {
    return (
      <main className="login">
        <div className="login-card">
          <span className="brand"><span className="brand-mark" aria-hidden="true" />FIDEON</span>
          <h1>관리자 로그인</h1>
          <LoginForm />
        </div>
      </main>
    );
  }
  return <LoginPreview />;
}
