import { PageShell } from '@/components/Site';
import { ConsultForm } from '@/components/ConsultForm';
import { CATALOG, fixedConsultInterest } from '@/content/catalog';
import { KAKAO_CHANNEL_URL } from '@/content/products';
import { EXTERNAL_CONSULT_ENABLED } from '@/content/channels';

// PHASE 1: 상담 대상은 인터넷+TV로 고정한다. 주소의 ?interest= 값은 읽지 않는다(예약 상품으로 바꿀 수 없음).
export default async function ConsultPage() {
  return (
    <PageShell>
      <section className="hero hero-compact">
        <p className="eyebrow">무료 상담 신청</p>
        <h1>연락처만 남겨 주세요</h1>
        <p className="hero-lead">통신사별 확정 조건을 비교해 원하시는 시간에 안내해 드립니다.</p>
      </section>
      <section className="section">
        {/* 활성 상품만 넘긴다(현재 인터넷+TV 하나). 예약 상품 이름은 브라우저 코드로 내려가지 않는다 */}
        <ConsultForm options={[{ value: fixedConsultInterest(), label: CATALOG[fixedConsultInterest()].label }]} kakaoUrl={EXTERNAL_CONSULT_ENABLED ? KAKAO_CHANNEL_URL : null} />
      </section>
    </PageShell>
  );
}
