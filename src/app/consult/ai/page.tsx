import { PageShell } from '@/components/Site';
import { ConsultAiChat } from '@/components/ConsultAiChat';
import { ONLINE_CONSULT_NOTICE } from '@/content/channels';

export const dynamic = 'force-dynamic';

const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// 기본 꺼짐(CONSULT_CHAT_ENABLED). 켜져도 상품·통신사·지역 코드가 서버 설정에 없으면 입력창을 열지 않는다. 상품은 서버 설정 하나로 고정(고객이 바꿀 수 없음).
export default function ConsultAiPage() {
  const { CONSULT_CHAT_ENABLED: on, CONSULT_CHAT_CARRIER: carrier = '', CONSULT_CHAT_PRODUCT: productId = '', CONSULT_CHAT_REGION: regionCode = '' } = process.env;
  const ready = on === 'true' && CODE.test(carrier) && CODE.test(productId) && CODE.test(regionCode);
  return (
    <PageShell>
      <section className="hero hero-compact">
        <p className="eyebrow">{ONLINE_CONSULT_NOTICE}</p>
        <h1>{ready ? 'AI 상담' : 'AI 상담은 준비 중입니다'}</h1>
        <p className="hero-lead">{ready ? '요금·사은품은 승인된 안내만 알려 드립니다.' : '서비스 준비가 끝나면 이 페이지에서 안내해 드립니다.'}</p>
      </section>
      {ready && <section className="section"><ConsultAiChat choice={{ carrier, productId, regionCode }} /></section>}
    </PageShell>
  );
}
