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
  // 총판 공식 접수처 연결: 서버 상수 등록부만 사용(현재 꺼짐·빈 등록부 → 아무것도 그리지 않음)
  return <ProductPage slug="internet-tv" intake={officialIntakeFor('internet-tv')} inquiry={kakaoInquiryLink()} />;
}
