import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { listLeads } from '@/server/admin/leadsApi';
import { adminLeadsList } from '@/server/admin/leadsRoute';
import type { SqlTag } from '@/server/admin/leadsReadStore';
import { withRole } from '@/server/db/client';

// 관리자 리드 목록. 출처 분기(기본 mock)는 server/admin/leadsRoute.ts, 가상 목록 판정은 server/admin/leadsApi.ts
// db 출처는 지정된 로컬 폐기 시험 DB에서만 열리고(server/admin/leadsSource.ts), 그 밖에는 503으로 닫힌다.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return adminLeadsList(
    {
      env: () => process.env,
      mode: () => adminAuthMode(),
      requireStaff,
      // 기본 withRole(DATABASE_URL 접속). 출처 판정이 로컬 폐기 시험 DB URL만 허용한다
      runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)),
      mockList: () => listLeads({ mode: () => adminAuthMode(), requireStaff }),
      mockDetail: () => Promise.resolve(new Response(null, { status: 405 })),
    },
    req,
  );
}
