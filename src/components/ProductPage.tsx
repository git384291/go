import { PageShell } from '@/components/Site';
import { productBySlug, type ProductSlug } from '@/content/products';

export function ProductPage({ slug }: { slug: ProductSlug }) {
  const p = productBySlug(slug);
  return (
    <PageShell>
      <section className="hero hero-compact">
        <p className="eyebrow">{p.label}</p>
        <h1>{p.title}</h1>
        <p className="hero-lead">{p.lead}</p>
        <a className="btn btn-primary btn-lg" href={`/consult?interest=${p.interest}`}>이 상품으로 상담 신청</a>
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
