import type { AdminAuthMode } from '../auth/adminAuthMode';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';
import { getMockLead, listMockLeads } from './mockLeads';

/**
 * GET /api/admin/leads, /api/admin/leads/[id] 본체. 판정 의존성을 주입받아 경로 시험한다.
 * - 인증 스위치가 꺼져 있으면 항상 503(로컬 개발 서버 포함). 인증 없이 가상 데이터도 내보내지 않는다.
 * - 켜져 있으면 requireStaff(DB whoami) → 역할별 범위. 미인증 401, 권한 없음 403, 인증·DB 장애 503.
 * - 오류 응답은 코드만. 원문 오류·세션·서명 정보는 싣지 않는다. 모든 응답 no-store.
 */
export type LeadsApiDeps = {
  mode: () => AdminAuthMode;
  requireStaff: () => Promise<StaffIdentity>;
};

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const fail = (code: string, status: number) => json({ ok: false, code }, status);

async function staff(deps: LeadsApiDeps): Promise<StaffIdentity | Response> {
  if (deps.mode() !== 'supabase') return fail('ADMIN_AUTH_DISABLED', 503);
  try {
    return await deps.requireStaff();
  } catch (error) {
    if (error instanceof StaffAuthError) return error.status === 401 ? fail('UNAUTHENTICATED', 401) : fail('FORBIDDEN', 403);
    return fail('UNAVAILABLE', 503);
  }
}

function scoped<T>(run: () => T): T | Response {
  try {
    return run();
  } catch (error) {
    if (error instanceof StaffAuthError) return fail('FORBIDDEN', 403);
    return fail('UNAVAILABLE', 503);
  }
}

export async function listLeads(deps: LeadsApiDeps): Promise<Response> {
  const who = await staff(deps);
  if (who instanceof Response) return who;
  const items = scoped(() => listMockLeads(who));
  if (items instanceof Response) return items;
  return json({ ok: true, data_source: 'mock', items });
}

export async function leadDetail(deps: LeadsApiDeps, id: unknown): Promise<Response> {
  const who = await staff(deps);
  if (who instanceof Response) return who;
  const lead = scoped(() => getMockLead(who, id));
  if (lead instanceof Response) return lead;
  return lead ? json({ ok: true, data_source: 'mock', item: lead }) : fail('NOT_FOUND', 404);
}
