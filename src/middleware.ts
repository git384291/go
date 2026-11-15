import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { adminAuthMode } from './server/auth/adminAuthMode';

/**
 * 관리자 경로 전용.
 * - 관리자 응답은 캐시하지 않는다(공유 캐시·뒤로 가기 노출 방지).
 * - 인증이 켜져 있을 때만 Supabase 접근 토큰을 갱신하고 쿠키를 다시 쓴다.
 *   (Server Component는 쿠키를 쓸 수 없으므로 갱신은 여기서 한다.)
 * - 접근 허용 여부는 여기서 판단하지 않는다. 화면·액션이 DB(requireStaff)로 확인한다.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (adminAuthMode() === 'supabase') {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (list) => {
            for (const { name, value } of list) request.cookies.set(name, value);
            response = NextResponse.next({ request });
            for (const { name, value, options } of list) response.cookies.set(name, value, options);
          },
        },
      },
    );
    await supabase.auth.getClaims(); // 만료가 가까우면 갱신 → setAll로 쿠키 기록
  }
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = { matcher: ['/admin', '/admin/:path*'] };
