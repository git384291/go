import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ConsultPreviewChat } from '@/components/ConsultPreviewChat';

// 모바일 웹 상담 비공개 시안(가상 대화, PM 7011892065).
// - 공개 경로(/, /products, /consult)와 분리된 경로이고, 사이트 메뉴·sitemap·robots 어디에도 나오지 않는다.
// - 서버 환경값 CONSULT_PREVIEW_ENABLED가 정확히 'true'가 아니면 404다(기본 꺼짐). NEXT_PUBLIC이 아니므로 브라우저 코드로 내려가지 않는다.
// - 검색 제외 표시를 이 페이지에도 직접 둔다(루트 layout의 noindex와 별개).
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '상담 시안(비공개)',
  robots: { index: false, follow: false, nocache: true },
};

export default function ConsultPreviewPage() {
  if (process.env.CONSULT_PREVIEW_ENABLED !== 'true') notFound();
  return (
    <main>
      <ConsultPreviewChat />
    </main>
  );
}
