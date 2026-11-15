'use client';
import { useActionState } from 'react';
import { LOGIN_MESSAGES, type LoginState } from '@/content/adminLogin';
import { loginAction } from '../actions';

// 1단계 이메일·비밀번호 → 2단계 인증 앱 6자리. 오류 문구는 계정 존재 여부를 드러내지 않는다.
export function LoginForm() {
  const [state, submit, pending] = useActionState(loginAction, { step: 'password' } as LoginState);
  const onTotp = state.step === 'totp';
  const error = state.step !== 'done' ? state.error : undefined;
  return (
    <>
      <ol className="login-steps" aria-label="로그인 단계">
        <li className={onTotp ? '' : 'on'}>계정 확인</li>
        <li className={onTotp ? 'on' : ''}>2단계 인증</li>
      </ol>
      {error && <p className="form-error" role="alert">{LOGIN_MESSAGES[error]}</p>}
      <form action={submit}>
        <fieldset disabled={pending}>
          {onTotp ? (
            <>
              <input type="hidden" name="step" value="totp" />
              <label className="field">
                <span>인증 앱 6자리 코드</span>
                <input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required />
              </label>
              <button className="btn btn-primary btn-block" type="submit">로그인</button>
            </>
          ) : (
            <>
              <input type="hidden" name="step" value="password" />
              <label className="field">
                <span>이메일</span>
                <input name="email" type="email" autoComplete="username" required maxLength={320} />
              </label>
              <label className="field">
                <span>비밀번호</span>
                <input name="password" type="password" autoComplete="current-password" required maxLength={256} />
              </label>
              <button className="btn btn-primary btn-block" type="submit">다음</button>
            </>
          )}
        </fieldset>
      </form>
      <p className="hint">로그인 세션은 최대 12시간 유지됩니다.</p>
    </>
  );
}
