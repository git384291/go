// 관리자 로그인 UI. 1단계: 이메일+비밀번호 → TOTP 6자리(2단계 인증) → 서버가 aal2 확인 후 DB 세션 열기.
// 현재 빌드는 인증 서버 미연결 상태의 화면 미리보기다.
export default function AdminLoginPage() {
  return (
    <main className="login">
      <div className="login-card">
        <span className="brand"><span className="brand-mark" aria-hidden="true" />FIDEON</span>
        <h1>관리자 로그인</h1>
        <ol className="login-steps" aria-label="로그인 단계">
          <li className="on">계정 확인</li>
          <li>2단계 인증</li>
        </ol>
        <form>
          <fieldset disabled>
            <label className="field">
              <span>이메일</span>
              <input type="email" autoComplete="username" />
            </label>
            <label className="field">
              <span>비밀번호</span>
              <input type="password" autoComplete="current-password" />
            </label>
            <button className="btn btn-primary btn-block" type="submit">다음</button>
          </fieldset>
        </form>
        <p className="hint">다음 단계에서 인증 앱의 6자리 코드를 입력합니다. 로그인 세션은 최대 12시간 유지됩니다.</p>
        <p className="mock-badge">미리보기 · 인증 서버 미연결</p>
      </div>
    </main>
  );
}
