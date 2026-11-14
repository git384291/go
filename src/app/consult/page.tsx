import { PageShell } from '@/components/Site';
import { ConsultForm } from '@/components/ConsultForm';
import { CATALOG, fixedConsultInterest } from '@/content/catalog';
import { KAKAO_CHANNEL_URL } from '@/content/products';
import { EXTERNAL_CONSULT_ENABLED, ONLINE_CONSULT_NOTICE } from '@/content/channels';

// PHASE 1: 상담 대상은 인터넷+TV로 고정한다. 주소의 ?interest= 값은 읽지 않는다(예약 상품으로 바꿀 수 없음).
export default async function ConsultPage() {
  return (
    <PageShell>
      <section className="hero hero-compact">
        <p className="eyebrow">{ONLINE_CONSULT_NOTICE}</p>
        <h1>지금은 상담 신청을 받지 않습니다</h1>
        <p className="hero-lead">서비스 준비가 끝나면 이 페이지에서 안내해 드립니다. 아래는 준비 중인 신청 양식 미리보기입니다.</p>
      </section>
      <section className="section">
        {/* 활성 상품만 넘긴다(현재 인터넷+TV 하나). 예약 상품 이름은 브라우저 코드로 내려가지 않는다 */}
        <ConsultForm options={[{ value: fixedConsultInterest(), label: CATALOG[fixedConsultInterest()].label }]} kakaoUrl={EXTERNAL_CONSULT_ENABLED ? KAKAO_CHANNEL_URL : null} />
      </section>
    </PageShell>
  );
}
