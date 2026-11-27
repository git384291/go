import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import type { CrmAdminDeps, SqlTag } from '@/server/admin/crmAdmin';
import { contractAction, contractList } from '@/server/admin/contractAdmin';
import { withRole } from '@/server/db/client';

// 설치·정산·환수(대표만, 0069). 기본 닫힘(CRM과 같은 스위치). 금액은 응답에만, 로그·감사에 없음. 상태 순서·환수 판정은 DB 함수가 최종.
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
  return contractList(deps(), req);
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
  return contractAction(deps(), body);
}
