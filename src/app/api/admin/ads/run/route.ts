import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { adRunAction, adRunPlatform } from '@/server/admin/adRun';
import type { SqlTag } from '@/server/admin/adBudget';
import { withRole } from '@/server/db/client';

// 광고 집행 요청·성과 수집. 기본 닫힘(ADMIN_AD_SOURCE=db 로컬 DB만). 어댑터는 무료 모의(AD_PLATFORM=mock)뿐이라 실제 집행·과금 없음.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };

export async function POST(req: Request) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 2_000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H });
  }
  return adRunAction({
    env: () => process.env, mode: () => adminAuthMode(), requireStaff, platform: adRunPlatform(process.env),
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(),
  }, body);
}
