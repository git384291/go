import 'server-only';
import type { AdminAuthMode } from '../auth/adminAuthMode';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';
import { quotePolicy } from '@/server/policies';
import { dbReadReady } from './leadsSource';

/**
 * 관리자 정책 업로드·검증·승인·게시 서버 모듈 (PM 11/21). 의존성은 인자로만 받는다(route.ts가 서버 기본값을 넘긴다).
 * - 권한은 DB 함수(api.policy_*)가 최종 판정한다. 서버는 그 앞에서 한 번 더 좁힐 뿐이다: 승인·반려는 owner만, 초안·제출은 owner·policy_editor,
 *   조회는 owner·policy_editor·reviewer. 허용 밖 역할은 DB를 호출하지 않는다. 화면(클라이언트)은 권한을 정하지 못한다.
 * - 기본 닫힘: ADMIN_POLICY_SOURCE=db + 개발·시험의 지정된 로컬 폐기 DB(leadsSource.dbReadReady)일 때만 열린다. 그 밖은 503(인증·DB 0회).
 * - 검증(dryRun)은 DB를 쓰지 않는다. 견적 판정(quotePolicy)과 같은 규칙으로 업로드 내용을 다시 검사해 사유 코드를 돌려준다.
 * - DB 오류는 허용 목록 코드로만 바꿔 응답한다(SQL 메시지·접속 정보 비노출).
 * - '게시'는 승인과 별개다: DB 스위치 policy_publish를 켜는 것은 이 화면의 범위가 아니다(기존 set_feature_flag 경로).
 */
/** DB 실행기 모양(구조적 타입). 리드 어댑터 모듈과 분리해 둔다 */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<readonly unknown[]>;
export type TxRunner = <T>(fn: (tx: SqlTag) => Promise<T>) => Promise<T>;
type Env = Readonly<Record<string, string | undefined>>;
export type PolicyAdminDeps = {
  env: () => Env;
  mode: () => AdminAuthMode;
  requireStaff: () => Promise<StaffIdentity>;
  runInTransaction: TxRunner;
  now: () => Date;
};

const HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
} as const;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (code: string, status: number) => json({ ok: false, code }, status);

export function policyAdminReady(env: Env): boolean {
  if (env.ADMIN_POLICY_SOURCE !== 'db') return false;
  // 리드 조회와 같은 '지정된 로컬 폐기 시험 DB' 판정을 그대로 쓴다
  return dbReadReady({ ...env, ADMIN_LEADS_SOURCE: 'db' });
}

type Op = 'list' | 'create' | 'submit' | 'approve' | 'reject';
const ROLES: Record<Op, readonly string[]> = {
  list: ['owner', 'policy_editor', 'reviewer'],
  create: ['owner', 'policy_editor'],
  submit: ['owner', 'policy_editor'],
  approve: ['owner'],
  reject: ['owner'],
};

async function gate(deps: PolicyAdminDeps, op: Op): Promise<StaffIdentity | Response> {
  let ready = false;
  try { ready = policyAdminReady(deps.env()); } catch { ready = false; }
  if (!ready) return fail('POLICY_ADMIN_DISABLED', 503);
  if (deps.mode() !== 'supabase') return fail('ADMIN_AUTH_DISABLED', 503);
  let who: StaffIdentity;
  try {
    who = await deps.requireStaff();
  } catch (e) {
    if (e instanceof StaffAuthError) return fail(e.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', e.status === 401 ? 401 : 403);
    return fail('AUTH_UNAVAILABLE', 503);
  }
  if (!ROLES[op].includes(who.role)) return fail('FORBIDDEN', 403);
  return who;
}

const DB_MESSAGES = new Set(['REASON_REQUIRED', 'CHECKS_REQUIRED', 'SOURCE_NOT_QUOTABLE', 'CONFIRMED_AT_INVALID', 'VALIDITY_INVALID', 'INVALID_TRANSITION', 'INVALID_PAGE', 'POLICY_IMMUTABLE']);
function dbError(e: unknown): Response {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  if (err.code === '42501') return fail('FORBIDDEN', 403);
  if (err.code === 'FP001') return fail('PRODUCT_NOT_ACTIVE', 409);
  if (err.code === '23514') return fail('INVALID_TERMS', 422);
  if (err.code === '22023' && typeof err.message === 'string') {
    const m = err.message.trim();
    return fail(DB_MESSAGES.has(m) ? m : 'INVALID_INPUT', 422);
  }
  return fail('DB_UNAVAILABLE', 503);
}

const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENTS = ['household', 'soho', 'sme'];
const SOURCES = ['official_policy_sheet', 'distributor_notice', 'training_material', 'past_promotion', 'unverified_screenshot'];
const TERM_KEYS = ['monthlyFee', 'contractMonths', 'equipmentMonthlyFee', 'installFee', 'bundlePrerequisites', 'regionScope', 'customerBenefit'];
const UPLOAD_KEYS = ['supplierId', 'segment', 'carrier', 'productId', 'category', 'sourceKind', 'confirmedAt', 'validFrom', 'validUntil', 'productLabel', 'terms'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[], extra: readonly string[] = []) =>
  Object.keys(o).every((k) => keys.includes(k) || extra.includes(k)) && keys.every((k) => k in o);
const ms = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN);

export type Upload = {
  supplierId: string; segment: string; carrier: string; productId: string; category: string; sourceKind: string;
  confirmedAt: string; validFrom: string; validUntil: string; productLabel: string; terms: Record<string, unknown>;
};

/** 업로드 본문 형식 검사. 문제가 있으면 null(응답은 INVALID_UPLOAD) */
export function parseUpload(body: unknown): Upload | null {
  if (!isObj(body) || !exactKeys(body, UPLOAD_KEYS, ['dryRun'])) return null;
  const b = body;
  if (typeof b.supplierId !== 'string' || !CODE.test(b.supplierId) || typeof b.carrier !== 'string' || !CODE.test(b.carrier)) return null;
  if (typeof b.productId !== 'string' || !CODE.test(b.productId) || typeof b.category !== 'string' || !CODE.test(b.category)) return null;
  if (typeof b.segment !== 'string' || !SEGMENTS.includes(b.segment) || typeof b.sourceKind !== 'string' || !SOURCES.includes(b.sourceKind)) return null;
  if (typeof b.productLabel !== 'string' || b.productLabel.length < 1 || b.productLabel.length > 80) return null;
  if (![b.confirmedAt, b.validFrom, b.validUntil].every((t) => Number.isFinite(ms(t)))) return null;
  if (!isObj(b.terms) || !exactKeys(b.terms, TERM_KEYS) || Object.keys(b.terms).length !== TERM_KEYS.length) return null;
  for (const k of TERM_KEYS) {
    const t = b.terms[k];
    if (!isObj(t) || typeof t.known !== 'boolean' || (t.known && !('value' in t)) || JSON.stringify(t).length > 1500) return null;
  }
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') return null;
  return b as unknown as Upload;
}

/** 견적 판정과 같은 규칙으로 업로드를 검사한다(DB 미사용). 반환 reasons가 비어 있으면 그대로 견적 가능한 정책이다 */
export function validateUpload(u: Upload, now: Date): { quotable: boolean; reasons: readonly string[] } {
  const start = Math.max(now.getTime(), ms(u.validFrom), ms(u.confirmedAt));
  const evalAt = new Date(start);
  const scope = (u.terms.regionScope as { known: boolean; value?: unknown });
  const region = scope.known && Array.isArray(scope.value) && typeof scope.value[0] === 'string' ? scope.value[0] : 'region-1';
  const bundles = u.terms.bundlePrerequisites as { known: boolean; value?: unknown };
  const record = {
    supplierId: u.supplierId, segment: u.segment, carrier: u.carrier, productId: u.productId, productLabel: u.productLabel,
    category: u.category, version: 'upload-check', sourceKind: u.sourceKind, reviewStatus: 'approved',
    confirmedAt: u.confirmedAt, validFrom: u.validFrom, validUntil: { known: true, value: u.validUntil },
    ...u.terms, internal: { commissionKrw: null, sourceRef: null },
  };
  const r = quotePolicy([record], {
    supplierId: u.supplierId, segment: u.segment, carrier: u.carrier, productId: u.productId, regionCode: region,
    confirmedBundles: bundles.known && Array.isArray(bundles.value) ? { known: true, value: bundles.value } : { known: false },
  }, evalAt);
  return r.status === 'quote' ? { quotable: true, reasons: [] } : { quotable: false, reasons: r.reasons };
}

export async function listPolicies(deps: PolicyAdminDeps, req: Request): Promise<Response> {
  const g = await gate(deps, 'list');
  if (g instanceof Response) return g;
  let limit = 50, offset = 0;
  try {
    const p = new URL(req.url).searchParams;
    if (p.has('limit')) limit = Number(p.get('limit'));
    if (p.has('offset')) offset = Number(p.get('offset'));
  } catch { return fail('INVALID_PAGE', 400); }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return fail('INVALID_PAGE', 400);
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select id, supplier_id, segment, carrier, product_id, category, revision, state, source_kind, product_label,
                confirmed_at, valid_from, valid_until, content_hash, created_by, self_approval, created_at, decided_at, decision_reason
         from api.policy_list(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${limit}::int, ${offset}::int)`);
    if (!Array.isArray(rows) || rows.length > limit) return fail('INVALID_DATA', 502);
    return json({ ok: true, role: g.role, items: rows }, 200);
  } catch (e) { return dbError(e); }
}

export async function createPolicyDraft(deps: PolicyAdminDeps, body: unknown): Promise<Response> {
  const g = await gate(deps, 'create');
  if (g instanceof Response) return g;
  const u = parseUpload(body);
  if (!u) return fail('INVALID_UPLOAD', 422);
  const check = validateUpload(u, deps.now());
  if ((body as { dryRun?: boolean }).dryRun === true) return json({ ok: true, dryRun: true, ...check }, 200);
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select api.policy_create_draft(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${u.supplierId}, ${u.segment}, ${u.carrier}, ${u.productId},
           ${u.category}, ${u.sourceKind}, ${u.confirmedAt}::timestamptz, ${u.validFrom}::timestamptz, ${u.validUntil}::timestamptz,
           ${u.productLabel}, ${JSON.stringify(u.terms)}::text::jsonb) as id`);
    const id = (rows as readonly { id?: unknown }[])[0]?.id;
    if (typeof id !== 'string' || !UUID.test(id)) return fail('INVALID_DATA', 502);
    return json({ ok: true, id, ...check }, 201);
  } catch (e) { return dbError(e); }
}

const CHECKS = ['source_matched', 'validity', 'vat', 'benefit_terms', 'region_bundle'];
export async function policyAction(deps: PolicyAdminDeps, id: string, body: unknown): Promise<Response> {
  const action = isObj(body) ? body.action : undefined;
  if (action !== 'submit' && action !== 'approve' && action !== 'reject') return fail('INVALID_ACTION', 400);
  const g = await gate(deps, action);
  if (g instanceof Response) return g;
  if (!UUID.test(id)) return fail('INVALID_ID', 400);
  const b = body as Record<string, unknown>;
  try {
    if (action === 'submit') {
      if (!exactKeys(b, ['action'])) return fail('INVALID_INPUT', 422);
      await deps.runInTransaction(async (tx) => tx`select api.policy_submit(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${id}::uuid)`);
      return json({ ok: true }, 200);
    }
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (reason.length < 2 || reason.length > 500) return fail('REASON_REQUIRED', 422);
    if (action === 'reject') {
      if (!exactKeys(b, ['action', 'reason'])) return fail('INVALID_INPUT', 422);
      await deps.runInTransaction(async (tx) => tx`select api.policy_reject(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${id}::uuid, ${reason})`);
      return json({ ok: true }, 200);
    }
    if (!exactKeys(b, ['action', 'reason', 'checks']) || !isObj(b.checks) || !exactKeys(b.checks, CHECKS) || Object.keys(b.checks).length !== CHECKS.length
        || !CHECKS.every((k) => (b.checks as Record<string, unknown>)[k] === true)) return fail('CHECKS_REQUIRED', 422);
    await deps.runInTransaction(async (tx) =>
      tx`select api.policy_approve(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${id}::uuid, ${reason}, ${JSON.stringify(b.checks)}::text::jsonb)`);
    return json({ ok: true }, 200);
  } catch (e) { return dbError(e); }
}
