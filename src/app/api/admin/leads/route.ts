import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { listLeads } from '@/server/admin/leadsApi';

// 가상 데이터 전용 관리자 리드 목록. 판정·범위는 server/admin/leadsApi.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return listLeads({ mode: () => adminAuthMode(), requireStaff });
}
