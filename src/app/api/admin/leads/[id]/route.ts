import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import { leadDetail } from '@/server/admin/leadsApi';

// 가상 데이터 전용 관리자 리드 상세. 판정·범위는 server/admin/leadsApi.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return leadDetail({ mode: () => adminAuthMode(), requireStaff }, (await ctx.params).id);
}
