import 'server-only';
import type { AdminAuthMode } from '../auth/adminAuthMode';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';
import { AD_DAILY_CAP_KRW, AD_FIRST3DAYS_CAP_KRW } from '../advertising/budgetGuard';
import { dbReadReady } from './leadsSource';
import type { SqlTag, TxRunner } from './policyAdmin';

/**
 * 광고 예산 통제 서버 모듈 (PM 11/21). 실제 광고 집행·외부 광고 API 호출은 없다 — '지출해도 되는지'를 DB에 묻고 기록할 뿐이다.
 * - 판정은 DB 함수(api.ad_*)가 최종 결정한다(승인 없음·만료·일/총 한도·중복 요청 → BLOCK). 서버는 입력을 먼저 좁히고 역할을 한 번 더 막는다.
 * - 기본 닫힘: ADMIN_AD_SOURCE=db + 지정된 로컬 폐기 DB(dbReadReady)일 때만 열린다. 아니면 503(인증·DB 0회).
 * - 오류는 차단으로 취급한다(fail-closed): 지출 판정 중 어떤 예외든 응답은 decision=BLOCK, reason=ERROR.
 * - 한도 상한은 광고 초안 모듈의 승인 상한을 그대로 쓴다. 입력으로 올릴 수 없다.
 * - 승인·철회·지출 판정은 owner만. 조회는 owner·reviewer.
 */
type Env = Readonly<Record<string, string | undefined>>;
export type AdBudgetDeps = {
  env: () => Env;
  mode: () => AdminAuthMode;
  requireStaff: () => Promise<StaffIdentity>;
  runInTransaction: TxRunner;
  now: () => Date;
};
export type { SqlTag, TxRunner };

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' } as const;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (code: string, status: number) => json({ ok: false, code }, status);
const block = (reason: string, status: number) => json({ ok: false, decision: 'BLOCK', reason }, status);

export function adBudgetReady(env: Env): boolean {
  if (env.ADMIN_AD_SOURCE !== 'db') return false;
  return dbReadReady({ ...env, ADMIN_LEADS_SOURCE: 'db' });
}

type Op = 'overview' | 'approve' | 'revoke' | 'request' | 'launch' | 'collect' | 'funnel' | 'alert_resolve' | 'pause' | 'launch_resolve' | 'ai_get' | 'ai_set';
const ROLES: Record<Op, readonly string[]> = { overview: ['owner', 'reviewer'], approve: ['owner'], revoke: ['owner'], request: ['owner'], launch: ['owner'], collect: ['owner'], funnel: ['owner', 'reviewer'], alert_resolve: ['owner'], pause: ['owner'], launch_resolve: ['owner'], ai_get: ['owner', 'reviewer'], ai_set: ['owner'] };

async function gate(deps: AdBudgetDeps, op: Op): Promise<StaffIdentity | Response> {
  let ready = false;
  try { ready = adBudgetReady(deps.env()); } catch { ready = false; }
  if (!ready) return fail('AD_BUDGET_DISABLED', 503);
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

const DB_MESSAGES = new Set(['ALERT_OPEN', 'INVALID_ALERT', 'NO_OPEN_ALERT', 'INVALID_LIMIT', 'INVALID_PERFORMANCE', 'INVALID_RANGE', 'INVALID_BUDGET', 'REASON_REQUIRED', 'NO_ACTIVE_APPROVAL', 'INVALID_SPEND', 'INVALID_PAGE', 'NO_LAUNCH', 'INVALID_LAUNCH']);
function dbError(e: unknown): Response {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  if (err.code === '42501') return fail('FORBIDDEN', 403);
  if (err.code === '22023' && typeof err.message === 'string') return fail(DB_MESSAGES.has(err.message.trim()) ? err.message.trim() : 'INVALID_INPUT', 422);
  return fail('DB_UNAVAILABLE', 503);
}

const CAMPAIGN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REQ_KEY = /^[A-Za-z0-9-]{16,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const reasonOk = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 500;

export async function adBudgetOverview(deps: AdBudgetDeps, req: Request): Promise<Response> {
  const g = await gate(deps, 'overview');
  if (g instanceof Response) return g;
  let limit = 50;
  try { const p = new URL(req.url).searchParams; if (p.has('limit')) limit = Number(p.get('limit')); } catch { return fail('INVALID_PAGE', 400); }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('INVALID_PAGE', 400);
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select id, campaign_key, state, daily_cap_krw, total_cap_krw, valid_until, reason, created_at, revoke_reason, spent_today, spent_total
         from api.ad_budget_overview(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${limit}::int)`);
    if (!Array.isArray(rows) || rows.length > limit) return fail('INVALID_DATA', 502);
    return json({ ok: true, role: g.role, caps: { dailyKrw: AD_DAILY_CAP_KRW, totalKrw: AD_FIRST3DAYS_CAP_KRW }, items: rows }, 200);
  } catch (e) { return dbError(e); }
}

/** body.action: approve | revoke | request */
export async function adBudgetAction(deps: AdBudgetDeps, body: unknown): Promise<Response> {
  const action = isObj(body) ? body.action : undefined;
  if (action !== 'approve' && action !== 'revoke' && action !== 'request') return fail('INVALID_ACTION', 400);
  const g = await gate(deps, action);
  if (g instanceof Response) return action === 'request' ? block(await g.clone().json().then((j: { code?: string }) => j.code ?? 'ERROR').catch(() => 'ERROR'), g.status) : g;
  const b = body as Record<string, unknown>;
  const tag = <T>(fn: (tx: SqlTag) => Promise<T>) => deps.runInTransaction(fn);
  try {
    if (action === 'approve') {
      if (!exact(b, ['action', 'campaign', 'dailyCapKrw', 'totalCapKrw', 'hours', 'reason'])) return fail('INVALID_INPUT', 422);
      if (typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign) || !isInt(b.dailyCapKrw, 1, AD_DAILY_CAP_KRW) || !isInt(b.totalCapKrw, 1, AD_FIRST3DAYS_CAP_KRW)
          || (b.totalCapKrw as number) < (b.dailyCapKrw as number) || !isInt(b.hours, 1, 72)) return fail('INVALID_BUDGET', 422);
      if (!reasonOk(b.reason)) return fail('REASON_REQUIRED', 422);
      const until = new Date(deps.now().getTime() + (b.hours as number) * 3_600_000).toISOString();
      const rows = await tag(async (tx) =>
        tx`select api.ad_budget_approve(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.campaign as string}, ${b.dailyCapKrw as number}::int, ${b.totalCapKrw as number}::int, ${until}::timestamptz, ${(b.reason as string).trim()}) as id`);
      const id = (rows as readonly { id?: unknown }[])[0]?.id;
      if (typeof id !== 'string' || !UUID.test(id)) return fail('INVALID_DATA', 502);
      return json({ ok: true, id }, 201);
    }
    if (action === 'revoke') {
      if (!exact(b, ['action', 'campaign', 'reason'])) return fail('INVALID_INPUT', 422);
      if (typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign)) return fail('INVALID_BUDGET', 422);
      if (!reasonOk(b.reason)) return fail('REASON_REQUIRED', 422);
      await tag(async (tx) => tx`select api.ad_budget_revoke(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.campaign as string}, ${(b.reason as string).trim()})`);
      return json({ ok: true }, 200);
    }
    // request: 지출 판정. 입력이 틀리거나 오류가 나면 모두 차단
    if (!exact(b, ['action', 'campaign', 'amountKrw', 'requestKey'])) return block('INVALID_INPUT', 422);
    if (typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign) || !isInt(b.amountKrw, 1, AD_DAILY_CAP_KRW) || typeof b.requestKey !== 'string' || !REQ_KEY.test(b.requestKey)) return block('INVALID_INPUT', 422);
    const rows = await tag(async (tx) =>
      tx`select api.ad_spend_request(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.campaign as string}, ${b.amountKrw as number}::int, ${b.requestKey as string}) as r`);
    const r = (rows as readonly { r?: unknown }[])[0]?.r;
    if (!isObj(r) || (r.decision !== 'ALLOW' && r.decision !== 'BLOCK')) return block('ERROR', 502);
    return json({ ok: r.decision === 'ALLOW', ...r }, 200);
  } catch (e) {
    if (action === 'request') return block((e as { code?: string })?.code === '42501' ? 'FORBIDDEN' : 'ERROR', (e as { code?: string })?.code === '42501' ? 403 : 503);
    return dbError(e);
  }
}

// 같은 관문·오류 처리를 광고 집행·성과 모듈(adRun)이 그대로 쓴다(권한·기본 닫힘 규칙을 한곳에서 유지)
export { gate as adGate, dbError as adDbError, json as adJson, fail as adFail, block as adBlock };
