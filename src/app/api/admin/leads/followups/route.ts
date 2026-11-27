import { requireStaff } from '@/server/auth/requireStaff';
import { followupDone, followupList } from '@/server/admin/dealerPacket';
import { dealerPacketDeps } from '@/server/admin/dealerPacketDeps';

// 대표 후속 연락 목록(고객이 '대표 직접 연락'에 동의한 리드)·완료 처리. 대표만, 추가 전용 기록.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
void requireStaff;
const H = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };

export async function GET() {
  return followupList(dealerPacketDeps());
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 200) return new Response(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: H });
    body = JSON.parse(raw);
  } catch { return new Response(JSON.stringify({ ok: false, code: 'INVALID_JSON' }), { status: 400, headers: H }); }
  return followupDone(dealerPacketDeps(), body);
}
