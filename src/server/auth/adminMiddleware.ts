import { NextResponse, type NextRequest } from 'next/server';
import { adminAuthMode } from './adminAuthMode';
import { isAuthOutage } from './authErrors';

export { isAuthOutage };

/**
 * /admin 경로 middleware 본체. Supabase 클라이언트 생성은 주입받아 실제 NextRequest로 시험한다.
 * - 관리자 응답은 항상 Cache-Control: private, no-store.
 * - 인증이 켜져 있으면 접근 토큰을 갱신하고 갱신 쿠키를 응답에 싣는다.
 * - 인증 서버 장애(네트워크 예외·재시도 오류)면 보호 화면으로 보내지 않고 일반화된 503으로 닫는다.
 *   이미 받은 갱신 쿠키는 503 응답에도 보존한다. 원문 오류는 응답·로그에 남기지 않는다.
 * - 로그인 안 됨·토큰 무효는 장애가 아니다: 통과시키고 화면이 DB 확인 후 로그인으로 보낸다.
 */
export type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };
export type ClaimsClient = { auth: { getClaims: () => Promise<{ error: unknown }> } };
export type CreateClaimsClient = (cookies: {
  getAll: () => { name: string; value: string }[];
  setAll: (list: CookieToSet[]) => void;
}) => ClaimsClient;

const NO_STORE = 'private, no-store';
export const ADMIN_UNAVAILABLE_BODY = '잠시 후 다시 시도해 주세요.';

export async function adminMiddleware(
  request: NextRequest,
  createClient: CreateClaimsClient,
  env: Record<string, string | undefined> = process.env,
): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  if (adminAuthMode(env) === 'supabase') {
    let outage = false;
    try {
      const client = createClient({
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      });
      const { error } = await client.auth.getClaims(); // 만료가 가까우면 갱신 → setAll
      outage = isAuthOutage(error);
    } catch {
      outage = true;
    }
    if (outage) {
      const failed = new NextResponse(ADMIN_UNAVAILABLE_BODY, {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '30' },
      });
      for (const c of response.cookies.getAll()) failed.cookies.set(c);
      response = failed;
    }
  }
  response.headers.set('Cache-Control', NO_STORE);
  return response;
}
