import { PageShell } from '@/components/Site';
import { ConsultForm } from '@/components/ConsultForm';

const ALLOWED = new Set(['internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other']);

export default async function ConsultPage({ searchParams }: { searchParams?: Promise<{ interest?: string }> }) {
  const interest = (await searchParams)?.interest;
  return (
    <PageShell>
      <section className="hero hero-compact">
        <p className="eyebrow">무료 상담 신청</p>
        <h1>연락처만 남겨 주세요</h1>
        <p className="hero-lead">통신사별 확정 조건을 비교해 원하시는 시간에 안내해 드립니다.</p>
      </section>
      <section className="section">
        <ConsultForm defaultInterest={interest && ALLOWED.has(interest) ? interest : 'internet_tv'} />
      </section>
    </PageShell>
  );
}
