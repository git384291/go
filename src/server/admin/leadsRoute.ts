import 'server-only';
import type { AdminAuthMode } from '../auth/adminAuthMode';
import type { StaffIdentity } from '../auth/staffSession';
import { listLeadsReadResponse } from './leadsReadApi';
import { listMaskedLeads, type TxRunner } from './leadsReadStore';
import { dbReadReady, leadsSource } from './leadsSource';

/**
 * GET /api/admin/leads, /api/admin/leads/[id]의 출처 분기 조합 (PM 6913462268).
 * 의존성은 이 함수의 인자로만 받는다(route.ts가 서버 기본값을 넘긴다). 요청 내용으로 주입할 수 없다.
 *
 * 목록
 * - mock(기본·미설정): 기존 가상 목록 그대로(mockList)
 * - invalid: 503 LEADS_SOURCE_INVALID (Auth·DB 0회)
 * - db + 읽기 준비 미충족(배포 환경·원격·일반 DB 등): 503 LEADS_READ_DISABLED (Auth·DB 0회, mock으로 대체하지 않음)
 * - db + 준비됨: listLeadsReadResponse → requireStaff(서버 컨텍스트) → listMaskedLeads(주입 실행기)
 * 상세
 * - mock: 기존 가상 상세 그대로
 * - db·invalid: 503(가상 상세와 섞지 않음). 실제 상세 조회·원문 열람·상태 변경은 없다.
 */
export type AdminLeadsDeps = {
  env: () => Readonly<Record<string, string | undefined>>;
  mode: () => AdminAuthMode;
  requireStaff: () => Promise<StaffIdentity>;
  runInTransaction: TxRunner;
  mockList: () => Promise<Response>;
  mockDetail: () => Promise<Response>;
};

const HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
} as const;
const fail = (code: string, status: number) => new Response(JSON.stringify({ ok: false, code }), { status, headers: HEADERS });

function sourceOf(deps: AdminLeadsDeps) {
  try {
    const env = deps.env();
    return { source: leadsSource(env), ready: dbReadReady(env) };
  } catch {
    return { source: 'invalid' as const, ready: false };
  }
}

export async function adminLeadsList(deps: AdminLeadsDeps, req: Request): Promise<Response> {
  const { source, ready } = sourceOf(deps);
  if (source === 'mock') return deps.mockList();
  if (source !== 'db') return fail('LEADS_SOURCE_INVALID', 503);
  if (!ready) return fail('LEADS_READ_DISABLED', 503);
  let params: URLSearchParams;
  try {
    params = new URL(req.url).searchParams;
  } catch {
    return fail('INVALID_PAGE', 400);
  }
  return listLeadsReadResponse(
    {
      mode: deps.mode,
      readReady: () => true,
      requireStaff: deps.requireStaff,
      listLeads: (who, page) => listMaskedLeads({ enabled: () => true, runInTransaction: deps.runInTransaction }, who, page),
    },
    params,
  );
}

export async function adminLeadDetail(deps: AdminLeadsDeps): Promise<Response> {
  const { source } = sourceOf(deps);
  if (source === 'mock') return deps.mockDetail();
  if (source === 'db') return fail('LEADS_DETAIL_UNAVAILABLE', 503);
  return fail('LEADS_SOURCE_INVALID', 503);
}
