import { ProductPage } from '@/components/ProductPage';
import type { Metadata } from 'next';
import { pageMetadata } from '@/content/seo';

// 공식 주소 확정 전에는 canonical·OG URL 없음, 검색 차단은 layout이 유지
export function generateMetadata(): Metadata {
  return pageMetadata('internetTv');
}

export default function Page() {
  return <ProductPage slug="internet-tv" />;
}
