import type { ReactNode } from 'react';
import { ACTIVE_PRODUCTS, KAKAO_CHANNEL_URL } from '@/content/products';
import { EXTERNAL_CONSULT_ENABLED } from '@/content/channels';

export function SiteHeader() {
  return (
    <header className="site-header">
      <a href="/" className="brand" aria-label="FIDEON 홈">
        <span className="brand-mark" aria-hidden="true" />
        FIDEON
      </a>
      <nav className="site-nav" aria-label="상품">
        {/* PHASE 1: 활성 상품만 메뉴에 표시 */}
        {ACTIVE_PRODUCTS.map((p) => (
          <a key={p.slug} href={`/products/${p.slug}`}>{p.label}</a>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="footer-brand">FIDEON</p>
      <p>인터넷 + TV 가입 상담 및 접수 대행 서비스입니다.</p>
      <p>요금·사은품·설치 조건은 상담 시점에 통신사 확정 조건으로 안내합니다.</p>
      <p className="footer-links">
        <a href="/privacy">개인정보처리방침</a>
      </p>
      <p className="footer-muted">사업자 정보는 개인정보 처리 주체 확정 후 게시합니다.</p>
    </footer>
  );
}

export function StickyCta() {
  return (
    <div className="sticky-cta" role="region" aria-label="상담 바로가기">
      {/* PHASE 1 보완: 외부 상담 채널은 고객정보 수집 승인 전까지 표시하지 않는다 */}
      {EXTERNAL_CONSULT_ENABLED && <a className="btn btn-kakao" href={KAKAO_CHANNEL_URL}>카카오톡 상담</a>}
      <a className="btn btn-primary" href="/consult">상담 신청</a>
    </div>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
      <StickyCta />
    </>
  );
}
