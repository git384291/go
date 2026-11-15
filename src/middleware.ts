import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { adminMiddleware } from './server/auth/adminMiddleware';

/** 관리자 경로 전용. 동작 설명은 server/auth/adminMiddleware.ts. 허용 판단은 화면·액션이 DB로 한다. */
export function middleware(request: NextRequest) {
  return adminMiddleware(request, (cookies) =>
    createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies }),
  );
}

export const config = { matcher: ['/admin', '/admin/:path*'] };
