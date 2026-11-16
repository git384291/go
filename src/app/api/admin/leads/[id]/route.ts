import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { leadDetail } from '@/server/admin/leadsApi';
import { adminLeadDetail } from '@/server/admin/leadsRoute';

// 관리자 리드 상세. 기본 mock은 기존 가상 상세 그대로(server/admin/leadsApi.ts).
// db·잘못된 출처에서는 가상 상세와 섞지 않도록 503으로 막는다(실제 상세 조회는 아직 없음).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminLeadDetail({
    env: () => process.env,
    mode: () => adminAuthMode(),
    requireStaff,
    runInTransaction: () => Promise.reject(new Error('detail has no db path')),
    mockList: () => Promise.resolve(new Response(null, { status: 405 })),
    mockDetail: async () => leadDetail({ mode: () => adminAuthMode(), requireStaff }, (await ctx.params).id),
  });
}
