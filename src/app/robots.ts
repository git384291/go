import type { MetadataRoute } from 'next';
import { robotsRules } from '@/content/seo';

// 닫힌 기본값: 운영 + 검색 허용 + 공식 주소가 모두 있기 전에는 전체 차단(content/seo.ts)
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return robotsRules();
}
