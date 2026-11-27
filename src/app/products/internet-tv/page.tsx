import { ProductPage } from '@/components/ProductPage';
import type { Metadata } from 'next';
import { pageMetadata } from '@/content/seo';
import { officialIntakeFor } from '@/server/intake/officialIntakeConfig';
import { kakaoInquiryLink } from '@/server/inquiry/kakaoInquiryConfig';

// 공식 주소 확정 전에는 canonical·OG URL 없음, 검색 차단은 layout이 유지
export function generateMetadata(): Metadata {
  return pageMetadata('internetTv');
}

export default function Page() {
  // 공식 접수처 연결: 서버 고정 등록부만 사용(요청·환경값으로 목적지를 바꿀 수 없음)
  return <ProductPage slug="internet-tv" intake={officialIntakeFor('internet-tv')} inquiry={kakaoInquiryLink()} />;
}
