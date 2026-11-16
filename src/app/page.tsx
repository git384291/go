import { PageShell } from '@/components/Site';
import { ACTIVE_PRODUCTS, CARRIERS } from '@/content/products';
import { ONLINE_CONSULT_NOTICE } from '@/content/channels';
import type { Metadata } from 'next';
import { pageMetadata } from '@/content/seo';
import { OfficialIntakeCta } from '@/components/OfficialIntakeCta';
import { officialIntakeFor } from '@/server/intake/officialIntakeConfig';

// 공식 주소 확정 전에는 canonical·OG URL 없음, 검색 차단은 layout이 유지
export function generateMetadata(): Metadata {
  return pageMetadata('home');
}

export default function HomePage() {
  // 총판 공식 접수처 연결: 서버 상수 등록부만 사용(현재 꺼짐·빈 등록부 → 아무것도 그리지 않음)
  const intake = officialIntakeFor('internet-tv');
  return (
    <PageShell>
      <section className="hero">
        <p className="eyebrow">인터넷 + TV 결합</p>
        <h1>
          통신사 세 곳의 조건,
          <br />
          <em>한 번의 상담</em>으로 비교하세요
        </h1>
        <p className="hero-lead">
          우리 집에 맞는 속도와 구성을 먼저 듣고, {CARRIERS.join(' · ')} 결합 조건을 나란히 놓고 설명해 드립니다.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="/consult">{ONLINE_CONSULT_NOTICE}</a>
          <a className="btn btn-ghost btn-lg" href="#products">상품 둘러보기</a>
        </div>
        <OfficialIntakeCta intake={intake} />
        <ul className="carrier-row" aria-label="상담 가능 통신사">
          {CARRIERS.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>

      <section id="products" className="section">
        <h2 className="section-title">무엇을 알아보고 계세요?</h2>
        <div className="card-list">
          {ACTIVE_PRODUCTS.map((p, i) => (
            <a key={p.slug} className="product-card" href={`/products/${p.slug}`}>
              <span className="card-index">0{i + 1}</span>
              <span className="card-label">{p.label}</span>
              <span className="card-title">{p.title}</span>
              <span className="card-lead">{p.lead}</span>
              <span className="card-more">자세히 보기 →</span>
            </a>
          ))}
        </div>
      </section>

      <section className="section section-tint">
        <h2 className="section-title">서비스가 열리면 이렇게 진행돼요</h2>
        <p className="section-note">현재는 {ONLINE_CONSULT_NOTICE}으로, 상담 신청과 연락처를 받지 않습니다.</p>
        <ol className="steps">
          <li>
            <strong>상담 요청</strong>
            <span>이름과 연락처를 남기는 방식으로 운영할 예정입니다. 주소는 이 단계에서 받지 않습니다.</span>
          </li>
          <li>
            <strong>조건 비교 안내</strong>
            <span>통신사별 확정 조건을 나란히 비교해 설명합니다.</span>
          </li>
          <li>
            <strong>가입 접수 · 설치</strong>
            <span>결정하신 경우에만 접수하고, 설치 일정을 함께 잡습니다.</span>
          </li>
        </ol>
      </section>

      <section className="section">
        <h2 className="section-title">꼭 알아두세요</h2>
        <ul className="notice-list">
          <li>요금과 사은품은 상담 시점의 통신사 확정 조건으로만 안내합니다.</li>
          <li>약정 기간 안에 해지하면 통신사 약관에 따른 위약금이 생길 수 있습니다.</li>
          <li>기존 회선 유지 조건은 상품마다 다르며, 접수 전에 안내합니다.</li>
        </ul>
      </section>
    </PageShell>
  );
}
