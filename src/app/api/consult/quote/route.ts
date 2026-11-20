import { NextResponse } from 'next/server';
import { answerQuote, NO_APPROVED_POLICIES } from '@/server/consult/quoteAnswer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const noStore = { 'Cache-Control': 'private, no-store' };

// 승인된 정책 저장소가 연결되기 전까지 공급자는 빈 목록이다 → 항상 '담당자 확인' 안내. 스위치가 켜져도 금액은 나가지 않는다
export async function POST(req: Request) {
  if (process.env.CONSULT_QUOTE_ENABLED !== 'true') return NextResponse.json({ ok: false, code: 'DISABLED' }, { status: 503, headers: noStore });
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 1024) return NextResponse.json({ ok: false, code: 'PAYLOAD_TOO_LARGE' }, { status: 413, headers: noStore });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, code: 'INVALID_JSON' }, { status: 400, headers: noStore });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ ok: false, code: 'INVALID_JSON' }, { status: 400, headers: noStore });
  const b = body as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);
  if (!ok(b.carrier) || !ok(b.productId) || !ok(b.regionCode)) return NextResponse.json({ ok: false, code: 'INVALID_INPUT' }, { status: 400, headers: noStore });
  const supplierId = process.env.QUOTE_SUPPLIER_ID ?? '';
  if (!CODE.test(supplierId)) return NextResponse.json({ ok: false, code: 'SERVICE_NOT_READY' }, { status: 503, headers: noStore });
  const answer = answerQuote(NO_APPROVED_POLICIES, {
    supplierId, segment: 'household', carrier: b.carrier, productId: b.productId, regionCode: b.regionCode, confirmedBundles: { known: false },
  }, new Date());
  return NextResponse.json({ ok: true, kind: answer.kind, text: answer.text }, { status: 200, headers: noStore });
}
