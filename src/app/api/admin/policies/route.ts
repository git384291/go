import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { createPolicyDraft, listPolicies, type PolicyAdminDeps, type SqlTag } from '@/server/admin/policyAdmin';
import { withRole } from '@/server/db/client';

// 관리자 정책 목록·초안 업로드. 기본 닫힘(ADMIN_POLICY_SOURCE=db + 지정된 로컬 폐기 DB에서만). 권한 판정은 DB 함수가 한다.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = (): PolicyAdminDeps => ({
  env: () => process.env,
  mode: () => adminAuthMode(),
  requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)),
  now: () => new Date(),
});

export function GET(req: Request) {
  return listPolicies(deps(), req);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 12_000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } });
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } });
  }
  return createPolicyDraft(deps(), body);
}
