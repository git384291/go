import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { adBudgetAction, adBudgetOverview, type AdBudgetDeps, type SqlTag } from '@/server/admin/adBudget';
import { withRole } from '@/server/db/client';

// 광고 예산 통제(승인·철회·지출 판정·조회). 기본 닫힘. 실제 광고 집행 코드는 없다.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = (): AdBudgetDeps => ({
  env: () => process.env, mode: () => adminAuthMode(), requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
});
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };

export function GET(req: Request) {
  return adBudgetOverview(deps(), req);
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
  return adBudgetAction(deps(), body);
}
