import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { signingKeyFromEnv } from '../security/token';
import { staffAssertion, staffSessionOpenAssertion, StaffAuthError, type StaffAuth } from './staffAssertion';
import { withRole } from '../db/client';

async function verifiedClaims() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        },
      },
    },
  );
  // 접근 토큰의 서명을 검증한 클레임만 사용한다. 쿠키 내용을 그대로 믿지 않는다.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) throw new StaffAuthError(401, 'UNAUTHENTICATED');
  return data.claims;
}

/** 관리자 Server Action·Route Handler 첫 줄에서 호출. 역할 판정은 DB 함수가 한다. */
export async function requireStaff(): Promise<StaffAuth> {
  return staffAssertion(await verifiedClaims(), signingKeyFromEnv('staff'));
}

/** 로그인(비밀번호 + TOTP) 완료 직후 1회 호출해 DB 자체 세션을 연다 */
export async function openStaffSession(): Promise<string> {
  const a = staffSessionOpenAssertion(await verifiedClaims(), signingKeyFromEnv('staff'));
  const rows = await withRole('staff', (tx) =>
    tx`select api.staff_session_open(${a.actor}::uuid, ${a.session}::uuid, ${a.token}) as role`,
  );
  return rows[0].role as string;
}
