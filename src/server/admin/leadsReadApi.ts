import 'server-only';
import type { AdminAuthMode } from '../auth/adminAuthMode';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';
import { isMaskedLeadDto, type ListResult, type MaskedLead } from './leadsReadStore';

/**
 * 실제 DB 마스킹 목록의 HTTP 응답 조합 (PM 6910895023). **미배선.**
 * - 모드 판정·requireStaff·목록 실행기를 모두 주입받는다. 기본 DB·환경값·키를 읽지 않고 원격에 연결하지 않는다.
 * - 현재 어떤 route.ts·페이지도 이 모듈을 import하지 않는다. 기존 GET /api/admin/leads(data_source:'mock')는 그대로다.
 *
 * 호출 순서: 인증 모드(supabase)·목록 읽기 준비 → requireStaff → 역할(owner·counselor) → 페이지 인자 → 목록 실행기
 * - 모드 꺼짐 또는 읽기 준비 꺼짐: requireStaff·목록 0회, 503
 * - 미인증 401, 권한 없음 403(reviewer·policy_editor는 목록 0회), 잘못된 페이지 400, 준비 안 됨·장애 503, 정상 200
 * - actor·session·token·role은 서버 검증 컨텍스트(requireStaff)에서만 얻는다. 요청 query·body의 같은 이름 값은 읽지 않는다.
 * - 내부 판정(INVALID_DATA·SCOPE_VIOLATION)과 DB 오류 원문·쿼리·키·세션은 응답에 넣지 않고 UNAVAILABLE로 닫는다.
 * - 정상 응답 형태: { ok: true, data_source: 'db', items: [7키 DTO] }. 가상 API는 data_source:'mock'으로 구분된다.
 */

export const READ_DATA_SOURCE = 'db' as const;

export type LeadsReadApiDeps = {
  mode: () => AdminAuthMode;
  /** 실제 목록 읽기 준비 스위치(기본 꺼짐으로 배선할 것) */
  readReady: () => boolean;
  requireStaff: () => Promise<StaffIdentity>;
  listLeads: (identity: StaffIdentity, page: { limit: number; offset: number }) => Promise<ListResult>;
};

const HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (code: string, status: number) => json({ ok: false, code }, status);

const PAGE_RE = /^\d{1,6}$/;
function pageFrom(params: URLSearchParams): { limit: number; offset: number } | null {
  const rawLimit = params.get('limit');
  const rawOffset = params.get('offset');
  if (params.getAll('limit').length > 1 || params.getAll('offset').length > 1) return null;
  const limit = rawLimit === null ? 50 : PAGE_RE.test(rawLimit) ? Number(rawLimit) : NaN;
  const offset = rawOffset === null ? 0 : PAGE_RE.test(rawOffset) ? Number(rawOffset) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return null;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) return null;
  return { limit, offset };
}

/** 검증된 DTO에서도 허용된 7키만 다시 골라 새 객체로 만든다 */
const pick = (i: MaskedLead) => ({
  id: i.id,
  createdAt: i.createdAt,
  nameMasked: i.nameMasked,
  phoneMasked: i.phoneMasked,
  interest: i.interest,
  status: i.status,
  assignedTo: i.assignedTo,
});

function safeBool(f: () => unknown): boolean {
  try {
    return f() === true;
  } catch {
    return false;
  }
}

/** 조립·직렬화를 포함한 모든 예기치 않은 실패를 503 UNAVAILABLE(no-store·nosniff)로 닫는다 */
export async function listLeadsReadResponse(deps: LeadsReadApiDeps, params: URLSearchParams): Promise<Response> {
  try {
    return await respond(deps, params);
  } catch {
    return fail('UNAVAILABLE', 503);
  }
}

async function respond(deps: LeadsReadApiDeps, params: URLSearchParams): Promise<Response> {
  let mode: AdminAuthMode | null = null;
  try {
    mode = deps.mode();
  } catch {
    mode = null;
  }
  if (mode !== 'supabase') return fail('ADMIN_AUTH_DISABLED', 503);
  if (!safeBool(deps.readReady)) return fail('LEADS_READ_DISABLED', 503);

  let who: StaffIdentity;
  try {
    who = await deps.requireStaff();
  } catch (error) {
    if (error instanceof StaffAuthError) return error.status === 401 ? fail('UNAUTHENTICATED', 401) : fail('FORBIDDEN', 403);
    return fail('UNAVAILABLE', 503);
  }
  if (!who || (who.role !== 'owner' && who.role !== 'counselor')) return fail('FORBIDDEN', 403);

  const page = pageFrom(params);
  if (!page) return fail('INVALID_PAGE', 400);

  let result: ListResult;
  try {
    result = await deps.listLeads(who, page);
  } catch {
    return fail('UNAVAILABLE', 503);
  }
  if (result && result.ok === true && Array.isArray(result.items)) {
    // 항목은 store 계약(7키·마스킹 모양·ISO 시각)으로 다시 확인한다. null·불완전 항목이 하나라도 있으면 성공 응답을 만들지 않는다
    try {
      if (!result.items.every((i) => isMaskedLeadDto(i))) return fail('UNAVAILABLE', 503);
      const body = JSON.stringify({ ok: true, data_source: READ_DATA_SOURCE, items: result.items.map(pick) });
      return new Response(body, { status: 200, headers: HEADERS });
    } catch {
      return fail('UNAVAILABLE', 503);
    }
  }
  const code = result && result.ok === false ? result.code : undefined;
  if (code === 'FORBIDDEN') return fail('FORBIDDEN', 403);
  if (code === 'INVALID_PAGE') return fail('INVALID_PAGE', 400);
  if (code === 'DISABLED') return fail('LEADS_READ_DISABLED', 503);
  return fail('UNAVAILABLE', 503); // INVALID_DATA·SCOPE_VIOLATION·UNAVAILABLE·알 수 없는 값
}
