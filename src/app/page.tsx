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
      <section className="hero hero-home">
        <div className="hero-copy">
          <p className="eyebrow">인터넷 + TV, 조건부터 차분히</p>
          <h1>
            광고 문구보다,
            <br />
            <em>우리 집에 맞는 조건</em>을 봅니다
          </h1>
          <p className="hero-lead">
            사용 환경을 먼저 정리한 뒤 {CARRIERS.join(' · ')}의 가입 조건을 같은 기준으로 비교합니다.
            확인되지 않은 요금이나 혜택은 미리 약속하지 않습니다.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary btn-lg" href="#compare">비교 기준 먼저 보기</a>
            <a className="btn btn-ghost btn-lg" href="/consult">{ONLINE_CONSULT_NOTICE}</a>
          </div>
          <OfficialIntakeCta intake={intake} />
          <ul className="carrier-row" aria-label="비교 대상 통신사">
            {CARRIERS.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>

        <aside className="hero-checklist" aria-label="비교 전에 확인할 내용">
          <p className="hero-checklist-kicker">먼저 세 가지만 정리해 두세요</p>
          <ol>
            <li><strong>사용 방식</strong><span>영상·게임·재택근무와 동시 접속 기기 수</span></li>
            <li><strong>현재 상황</strong><span>신규 설치·이사·통신사 변경 중 어디에 해당하는지</span></li>
            <li><strong>결합 대상</strong><span>휴대폰 통신사와 함께 묶을 가족 회선이 있는지</span></li>
          </ol>
          <p className="hero-checklist-note">주소·연락처는 서비스가 열리기 전까지 받지 않습니다.</p>
        </aside>
      </section>

      <section id="products" className="section">
        <p className="section-kicker">상품 안내</p>
        <h2 className="section-title">지금 필요한 구성부터 살펴보세요</h2>
        <p className="section-intro">노출 가능한 상품만 보여 드립니다. 각 화면에서 비교 항목과 가입 전 확인사항을 먼저 확인할 수 있습니다.</p>
        <div className="card-list">
          {ACTIVE_PRODUCTS.map((p, i) => (
            <a key={p.slug} className="product-card" href={`/products/${p.slug}`}>
              <span className="card-index">0{i + 1}</span>
              <span className="card-label">{p.label}</span>
              <span className="card-title">{p.title}</span>
              <span className="card-lead">{p.lead}</span>
              <span className="card-more">자세히 보기</span>
            </a>
          ))}
        </div>
      </section>

      <section id="compare" className="section section-tint compare-section">
        <div className="section-heading-row">
          <div>
            <p className="section-kicker">비교 기준</p>
            <h2 className="section-title">통신사 이름보다 먼저 볼 것</h2>
          </div>
          <p className="section-intro">같은 상품명도 집의 사용 환경과 결합 조건에 따라 선택이 달라질 수 있습니다.</p>
        </div>
        <div className="compare-grid">
          <article><span>01</span><h3>인터넷 속도</h3><p>기기 수와 사용 용도를 기준으로 필요한 구간을 정합니다.</p></article>
          <article><span>02</span><h3>TV 구성</h3><p>보는 채널과 셋톱박스 대수를 확인해 불필요한 구성을 줄입니다.</p></article>
          <article><span>03</span><h3>결합 조건</h3><p>휴대폰·기존 회선과 묶을 수 있는지는 통신사별로 따로 확인합니다.</p></article>
          <article><span>04</span><h3>설치 가능 여부</h3><p>주소와 건물 환경에 따른 설치 가능 여부는 공식 접수 단계에서 확정합니다.</p></article>
        </div>
      </section>

      <section className="section process-section">
        <div>
          <p className="section-kicker">진행 방식</p>
          <h2 className="section-title">서비스가 열리면 이렇게 진행합니다</h2>
          <p className="section-note">현재는 {ONLINE_CONSULT_NOTICE}으로, 상담 신청과 연락처를 받지 않습니다.</p>
        </div>
        <ol className="steps">
          <li><strong>사용 환경 확인</strong><span>속도·TV·결합에 필요한 조건을 먼저 정리합니다.</span></li>
          <li><strong>조건 비교 안내</strong><span>확인된 통신사별 조건을 같은 기준으로 설명합니다.</span></li>
          <li><strong>고객 결정</strong><span>충분히 비교한 뒤 진행 여부를 직접 선택합니다.</span></li>
          <li><strong>공식 접수 · 설치</strong><span>진행을 선택한 경우에만 접수하고 설치 일정을 확인합니다.</span></li>
        </ol>
      </section>

      <section className="section trust-section">
        <div className="trust-copy">
          <p className="section-kicker">바른365의 안내 원칙</p>
          <h2 className="section-title">확정되지 않은 말로 서두르게 하지 않습니다</h2>
          <p>조건이 달라질 수 있는 내용은 확인이 필요하다고 표시하고, 접수 전 꼭 알아야 할 약정과 해지 조건을 함께 안내합니다.</p>
        </div>
        <ul className="notice-list">
          <li>요금과 사은품은 상담 시점의 통신사 확정 조건으로만 안내합니다.</li>
          <li>약정 기간 안에 해지하면 통신사 약관에 따른 위약금이 생길 수 있습니다.</li>
          <li>기존 회선 유지와 결합 조건은 상품마다 다르므로 접수 전에 확인합니다.</li>
          <li>주민등록번호·신분증·계좌번호는 공개 채팅이나 메시지로 받지 않습니다.</li>
        </ul>
      </section>
    </PageShell>
  );
}
