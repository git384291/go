import { adSchedulerHandler } from '@/server/admin/adSchedulerRoute';

// 광고 활성화 예약 실행(PM 11/25 ②③). 외부 스케줄러가 POST + Authorization: Bearer <AD_SCHEDULER_SECRET>(32자 이상, 없으면 꺼짐)로 부른다.
// 기본 닫힘: ADMIN_AD_SOURCE=db일 때만. 실제 Google Ads ENABLED는 부르지 않는다(모의 플랫폼만 활성화). 결과는 캠페인 키·고정 코드만.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) { return adSchedulerHandler(req, process.env); }
