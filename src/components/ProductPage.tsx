import { notFound } from 'next/navigation';
import { PageShell } from '@/components/Site';
import { isActiveSlug, productBySlug, type ProductSlug } from '@/content/products';
import { ONLINE_CONSULT_NOTICE, PRODUCT_GUIDE_ENABLED } from '@/content/channels';
import { ProductGuidePanel } from '@/components/ProductGuidePanel';
import { OfficialIntakeCta } from '@/components/OfficialIntakeCta';
import type { OfficialIntakeResult } from '@/content/officialIntake';
import type { KakaoInquiryResult } from '@/content/kakaoInquiry';
import { KakaoInquiryLink } from '@/components/KakaoInquiryLink';

const GUIDE_INTAKE_OFF: OfficialIntakeResult = Object.freeze({ state: 'off', reason: 'DISABLED' });

// intake: 페이지(서버)가 서버 상수 등록부로 판정해 넘긴 결과. 넘기지 않으면 표시하지 않는다(화면 컴포넌트는 서버 모듈을 import하지 않음).
// inquiry: 페이지(서버)가 판정한 카카오톡 상품 문의 결과(인터넷TV만 전달). 넘기지 않거나 off면 표시하지 않는다.
export function ProductPage({ slug, intake, inquiry }: { slug: ProductSlug; intake?: OfficialIntakeResult; inquiry?: KakaoInquiryResult }) {
  // PHASE 1: 예약 상품 상세는 주소로 직접 들어와도 404. 화면 코드는 보존한다.
  if (!isActiveSlug(slug)) notFound();
  const p = productBySlug(slug);
  return (
    <PageShell>
      <section className="hero hero-compact">
        <p className="eyebrow">{p.label}</p>
        <h1>{p.title}</h1>
        <p className="hero-lead">{p.lead}</p>
        <a className="btn btn-primary btn-lg" href="/consult">{ONLINE_CONSULT_NOTICE}</a>
        {intake && <OfficialIntakeCta intake={intake} />}
        <KakaoInquiryLink inquiry={inquiry} />
      </section>

      <section className="section">
        <h2 className="section-title">이런 분께 맞아요</h2>
        <ul className="tag-list">
          {p.forWhom.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>

      <section className="section section-tint">
        <h2 className="section-title">상담에서 함께 정하는 것</h2>
        <dl className="option-list">
          {p.options.map((o) => (
            <div key={o.name}>
              <dt>{o.name}</dt>
              <dd>{o.desc}</dd>
            </div>
          ))}
        </dl>
        <p className="price-note">요금·사은품은 화면에 게시하지 않고 상담 때 확정 조건으로 안내합니다.</p>
      </section>

      <section className="section">
        <h2 className="section-title">가입 전 확인 사항</h2>
        <ul className="notice-list">
          {p.checks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>

      {/* 선택형 상품 안내: 코드 상수가 켜지고 인터넷TV일 때만. 기본 꺼짐 → 그리지 않음 */}
      {PRODUCT_GUIDE_ENABLED && slug === 'internet-tv' && <ProductGuidePanel intake={intake ?? GUIDE_INTAKE_OFF} />}
    </PageShell>
  );
}
