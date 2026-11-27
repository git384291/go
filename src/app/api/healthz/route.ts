export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 무인 상태 확인(Cloud Run 시작·활성 검사용). 프로세스가 요청을 받을 수 있는지만 답한다.
 * DB·외부 호출·환경 값·버전·비밀을 읽거나 돌려주지 않는다(정보 노출 0). 캐시 금지.
 */
const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } as const;

export function GET() {
  return new Response('{"ok":true}', { status: 200, headers: HEADERS });
}

export function HEAD() {
  return new Response(null, { status: 200, headers: HEADERS });
}
