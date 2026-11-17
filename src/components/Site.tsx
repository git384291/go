import type { ReactNode } from 'react';
import Link from 'next/link';
import { ACTIVE_PRODUCTS } from '@/content/products';
import { ONLINE_CONSULT_NOTICE } from '@/content/channels';

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="brand" aria-label="FIDEON 홈">
        <span className="brand-mark" aria-hidden="true" />
        FIDEON
      </Link>
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
      {/* 카카오톡 상품 문의는 공통 버튼에 두지 않는다(PM 6938169689). 상담·인터넷TV 페이지에서만 서버 판정으로 표시 */}
      <a className="btn btn-primary" href="/consult">{ONLINE_CONSULT_NOTICE}</a>
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
