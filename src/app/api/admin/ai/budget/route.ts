import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { aiBudgetGet, aiBudgetSet } from '@/server/admin/aiBudget';
import type { AdBudgetDeps, SqlTag } from '@/server/admin/adBudget';
import { withRole } from '@/server/db/client';

// AI 월 비용 한도 조회·설정(기본 닫힘, 로컬 시험 DB만). 한도를 올려도 실제 AI 호출 코드는 없다.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const deps = (): AdBudgetDeps => ({
  env: () => process.env, mode: () => adminAuthMode(), requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
});

export function GET() {
  return aiBudgetGet(deps());
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 1_000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H });
  }
  return aiBudgetSet(deps(), body);
}
