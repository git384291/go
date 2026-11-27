import type { Metadata } from 'next';
import { requireStaff } from '@/server/auth/requireStaff';
import { handoffList } from '@/server/admin/dealerPacket';
import { dealerPacketDeps } from '@/server/admin/dealerPacketDeps';
import { PacketConsole, type HandoffRow } from './PacketConsole';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '총판 전달용 신청서', robots: { index: false, follow: false, nocache: true } };
void requireStaff;

// 서버 셸: 권한·준비 여부는 handoffList(requireStaff·DB 판정)로 먼저 확인한다. 신청서 본문은 사유 입력 뒤에만 불러온다.
export default async function PacketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await handoffList(dealerPacketDeps(), id);
  if (res.status === 401) {
    const { redirect } = await import('next/navigation');
    return redirect('/admin/login');
  }
  const note = (m: string) => <main className="admin-main"><section className="admin-card" role="status"><h2>총판 전달용 신청서</h2><p>{m}</p></section></main>;
  if (res.status === 403) return note('이 접수 건을 볼 권한이 없습니다.');
  if (res.status === 503) return note('이 기능은 현재 꺼져 있습니다.');
  if (res.status !== 200) return note('불러오지 못했습니다.');
  const body = (await res.json()) as { items: HandoffRow[] };
  return <PacketConsole leadId={id} history={body.items} />;
}
