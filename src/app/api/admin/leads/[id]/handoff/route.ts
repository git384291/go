import { requireStaff } from '@/server/auth/requireStaff';
import { handoffList, handoffRecord } from '@/server/admin/dealerPacket';
import { dealerPacketDeps } from '@/server/admin/dealerPacketDeps';

// 총판 전달 이력(복사·전달 완료 기록, 조회). 추가 전용.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
void requireStaff;
const H = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handoffList(dealerPacketDeps(), (await ctx.params).id);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 1000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch { return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H }); }
  return handoffRecord(dealerPacketDeps(), (await ctx.params).id, body);
}
