import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { policyAction, type PolicyAdminDeps } from '@/server/admin/policyAdmin';
import type { SqlTag } from '@/server/admin/leadsReadStore';
import { withRole } from '@/server/db/client';

// 정책 제출·승인·반려. 승인·반려는 owner만(서버가 한 번 더 좁히고 DB 함수가 최종 판정).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = (): PolicyAdminDeps => ({
  env: () => process.env,
  mode: () => adminAuthMode(),
  requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)),
  now: () => new Date(),
});
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 4_000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H });
  }
  const { id } = await ctx.params;
  return policyAction(deps(), id, body);
}
