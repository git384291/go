import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { policyPublishGet, policyPublishSet, type PolicyAdminDeps, type SqlTag } from '@/server/admin/policyAdmin';
import { withRole } from '@/server/db/client';

// 정책 게시 스위치 조회·변경. 변경은 대표만(서버·DB 모두 판정), 사유 필수, 감사 기록. 기본 닫힘(ADMIN_POLICY_SOURCE=db + 지정된 로컬 폐기 DB).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = (): PolicyAdminDeps => ({
  env: () => process.env, mode: () => adminAuthMode(), requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
});
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };

export function GET() {
  return policyPublishGet(deps());
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 1000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch { return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H }); }
  return policyPublishSet(deps(), body);
}
