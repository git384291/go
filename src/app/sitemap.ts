import type { MetadataRoute } from 'next';
import { sitemapEntries } from '@/content/seo';

// 닫힌 기본값: 검색 허용 전에는 빈 sitemap(비공개·준비 중 경로를 나열하지 않음)
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries();
}
