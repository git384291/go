import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { noticeReviewAdd, noticeReviewList, type PolicyAdminDeps, type SqlTag } from '@/server/admin/policyAdmin';
import { withRole } from '@/server/db/client';

// 총판 고지 조건 검수 기록(대표·검토자). 추가 전용이며 승인해도 접수는 열리지 않는다(코드 상수 확정 필요).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = (): PolicyAdminDeps => ({
  env: () => process.env, mode: () => adminAuthMode(), requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
});
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };

export function GET() {
  return noticeReviewList(deps());
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 2000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch { return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H }); }
  return noticeReviewAdd(deps(), body);
}
