import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { crmAction, crmList, type CrmAdminDeps, type SqlTag } from '@/server/admin/crmAdmin';
import { withRole } from '@/server/db/client';

// 날짜별 재연락·미처리 고객(대표만). 기본 닫힘(ADMIN_CRM_SOURCE=db + 지정된 로컬 폐기 DB). 실제 발신 없음. 권한·동의 판정은 DB 함수가 최종.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = (): CrmAdminDeps => ({
  env: () => process.env,
  mode: () => adminAuthMode(),
  requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)),
  now: () => new Date(),
});
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };

export function GET(req: Request) {
  return crmList(deps(), req);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 2_000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H });
  }
  return crmAction(deps(), body);
}
