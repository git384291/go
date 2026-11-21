import { requireStaff } from '@/server/auth/requireStaff';
import { dealerPacketGet } from '@/server/admin/dealerPacket';
import { dealerPacketDeps } from '@/server/admin/dealerPacketDeps';

// 총판 전달용 신청서 열람(사유 필수·열람 이력·감사). 서버 권한 확인은 dealerPacket(requireStaff 주입)이 한다.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
void requireStaff;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 1000) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' } });
    body = JSON.parse(raw);
  } catch { return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' } }); }
  return dealerPacketGet(dealerPacketDeps(), (await ctx.params).id, body);
}
