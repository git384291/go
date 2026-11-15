import { PageShell } from '@/components/Site';
import type { Metadata } from 'next';
import { pageMetadata } from '@/content/seo';

// 공식 주소 확정 전에는 canonical·OG URL 없음, 검색 차단은 layout이 유지
export function generateMetadata(): Metadata {
  return pageMetadata('privacy');
}

export default function PrivacyPage() {
  return (
    <PageShell>
      <section className="section">
        <h1 className="section-title">개인정보처리방침</h1>
        <p>
          처리 주체, 제3자 제공 대상, 위탁 업체, 보유 기간은 법률 확인 후 확정해 게시합니다. 확정 전까지 이 사이트는
          개인정보를 수집하지 않습니다.
        </p>
      </section>
    </PageShell>
  );
}
