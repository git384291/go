import { notFound } from 'next/navigation';
import { PageShell } from '@/components/Site';
import { isActiveSlug, productBySlug, type ProductSlug } from '@/content/products';
import { ONLINE_CONSULT_NOTICE } from '@/content/channels';
import { OfficialIntakeCta } from '@/components/OfficialIntakeCta';
import { officialIntakeFor } from '@/server/intake/officialIntakeConfig';

export function ProductPage({ slug }: { slug: ProductSlug }) {
  // PHASE 1: 예약 상품 상세는 주소로 직접 들어와도 404. 화면 코드는 보존한다.
  if (!isActiveSlug(slug)) notFound();
  const p = productBySlug(slug);
  // 총판 공식 접수처 연결: 서버 상수 등록부만 사용(현재 꺼짐·빈 등록부 → 아무것도 그리지 않음)
  const intake = officialIntakeFor(slug);
  return (
    <PageShell>
      <section className="hero hero-compact">
        <p className="eyebrow">{p.label}</p>
        <h1>{p.title}</h1>
        <p className="hero-lead">{p.lead}</p>
        <a className="btn btn-primary btn-lg" href="/consult">{ONLINE_CONSULT_NOTICE}</a>
        <OfficialIntakeCta intake={intake} />
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
    </PageShell>
  );
}
