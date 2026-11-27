import { NextResponse } from 'next/server';
import { withRole } from '@/server/db/client';
import { intakePolicyFromEnv } from '@/server/leads/policyFault';

// 접수 화면 잠금용 현재 정책 상태(PM 11/24 결정). 접수 API(route.ts)·DB 게이트와 같은 판정(서버 설정 상품 키, 현재 게시 정책)을 쓴다.
// 화면 표시용일 뿐이고 실제 차단은 접수 API·DB가 다시 한다. 고객 값·상담 결과를 받지 않으며 정책 내용·오류 원문을 내보내지 않는다(열림 여부만).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const H = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  const policy = intakePolicyFromEnv(process.env);
  if (!policy.key) return NextResponse.json({ ok: true, open: false }, { headers: H });
  try {
    const rows = (await withRole('public', (tx) => tx`select api.policy_published() as p`)) as unknown as { p: unknown }[];
    const v = await policy.verdict(rows.map((r) => r.p), new Date());
    return NextResponse.json({ ok: true, open: v === null }, { headers: H });
  } catch {
    return NextResponse.json({ ok: true, open: false }, { headers: H }); // 조회 실패: 잠금(fail-closed)
  }
}
