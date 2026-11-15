'use server';
import { redirect } from 'next/navigation';
import { signingKeyFromEnv } from '@/server/security/token';
import { adminAuthMode } from '@/server/auth/adminAuthMode';
import type { LoginState } from '@/content/adminLogin';
import { logoutFlow, passwordStep, totpStep } from '@/server/auth/loginFlow';
import { openStaffSessionWithDb, revokeStaffSessionWithDb } from '@/server/auth/staffSessionDb';
import { authPort, supabaseServer } from '@/server/auth/supabaseServer';

// 관리자 로그인 Server Action. 인증 스위치가 꺼져 있으면 어떤 외부 호출도 하지 않는다.
const OFF: LoginState = { step: 'password', error: 'UNAVAILABLE' };

/** 한 폼 상태로 두 단계를 처리한다. step 값은 화면이 보낸 값이지만, 실제 허용은 Supabase·DB가 판단한다. */
export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (adminAuthMode() === 'disabled') return OFF;
  const port = authPort(await supabaseServer());
  if (form.get('step') !== 'totp') {
    return passwordStep({ email: form.get('email'), password: form.get('password') }, port);
  }
  const state = await totpStep({ code: form.get('code') }, port, async (claims) =>
    (await openStaffSessionWithDb(claims, signingKeyFromEnv('staff'))).role,
  );
  if (state.step === 'done') redirect('/admin');
  return state;
}

export async function logoutAction(): Promise<void> {
  if (adminAuthMode() !== 'disabled') {
    await logoutFlow(authPort(await supabaseServer()), (claims) => revokeStaffSessionWithDb(claims, signingKeyFromEnv('staff')));
  }
  redirect('/admin/login');
}
