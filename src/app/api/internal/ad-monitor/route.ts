import { adMonitorHandler } from '@/server/admin/adMonitorRoute';

// 광고 정기 감시(PM 11/22 P0). 외부 스케줄러가 Authorization: Bearer <AD_MONITOR_SECRET>로 부른다(32자 이상, 없으면 꺼짐).
// 기본 닫힘: ADMIN_AD_SOURCE=db 로컬 폐기 DB일 때만. 결과는 캠페인 키·고정 코드만(비밀·외부 ID 없음). 정상이 아니면 503.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) { return adMonitorHandler(req, process.env); }
export async function POST(req: Request) { return adMonitorHandler(req, process.env); }
