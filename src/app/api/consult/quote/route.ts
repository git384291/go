import { NextResponse } from 'next/server';
import { answerQuote } from '@/server/consult/quoteAnswer';
import { dbPolicyProvider } from '@/server/consult/publishedPolicies';
import { withRole } from '@/server/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const noStore = { 'Cache-Control': 'private, no-store' };

// 기본 꺼짐(CONSULT_QUOTE_ENABLED). 켜져도 DB의 게시 함수(승인·유효·policy_publish 스위치)를 통과한 정책만 쓰고, 서버가 견적 판정에서 다시 검사한다.
// 조회 실패·정책 없음은 모두 '담당자 확인' 안내다.
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
  const published = dbPolicyProvider(async () => {
    const rows = await withRole('public', (tx) => tx`select api.policy_published() as p`);
    return (rows as unknown as { p: unknown }[]).map((r) => r.p);
  });
  const answer = await answerQuote(published, {
    supplierId, segment: 'household', carrier: b.carrier, productId: b.productId, regionCode: b.regionCode, confirmedBundles: { known: false },
  }, new Date());
  return NextResponse.json({ ok: true, kind: answer.kind, text: answer.text }, { status: 200, headers: noStore });
}
