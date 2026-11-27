import 'server-only';
import type { AdminAuthMode } from '../auth/adminAuthMode';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';
import { dbReadReady } from './leadsSource';
import type { SqlTag, TxRunner } from './policyAdmin';

/**
 * 날짜별 고객 관리·재연락 관리자 API (PM 11/25). DB 함수(0060·0061)를 부르기만 한다.
 * - 실제 발신(전화·문자·알림톡) 코드는 없다. 재연락은 "예약·목록·완료 기록"뿐이고, 연락은 사람이 한다.
 * - 동의·수신 거부 판정은 DB(core.recontact_allowed)가 최종: NO_CONSENT·OPTED_OUT이면 예약·완료 거부, 목록에서도 빠진다.
 * - 같은 날 같은 고객 중복 예약은 DB가 'exists'로 돌려준다(중복 알림·중복 연락 방지).
 * - 기본 닫힘: ADMIN_CRM_SOURCE=db + 지정된 로컬 폐기 DB(dbReadReady)일 때만. 아니면 503(인증·DB 0회).
 * - 모든 기능은 대표(owner)만. 서버가 먼저 막고 DB가 한 번 더 막는다.
 * - 응답은 허용 필드만 골라 담는다(DB가 다른 열을 돌려줘도 밖으로 내보내지 않음). 이름은 가린 값만.
 */
type Env = Readonly<Record<string, string | undefined>>;
export type CrmAdminDeps = {
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

export function crmAdminReady(env: Env): boolean {
  if (env.ADMIN_CRM_SOURCE !== 'db') return false;
  return dbReadReady({ ...env, ADMIN_LEADS_SOURCE: 'db' });
}

/** 기본 닫힘·인증·대표 확인(설치·정산 API도 같은 관문을 쓴다) */
export async function gate(deps: CrmAdminDeps): Promise<StaffIdentity | Response> {
  let ready = false;
  try { ready = crmAdminReady(deps.env()); } catch { ready = false; }
  if (!ready) return fail('CRM_DISABLED', 503);
  if (deps.mode() !== 'supabase') return fail('ADMIN_AUTH_DISABLED', 503);
  let who: StaffIdentity;
  try {
    who = await deps.requireStaff();
  } catch (e) {
    if (e instanceof StaffAuthError) return fail(e.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', e.status === 401 ? 401 : 403);
    return fail('AUTH_UNAVAILABLE', 503);
  }
  if (who.role !== 'owner') return fail('FORBIDDEN', 403);
  return who;
}

const DB_MESSAGES = new Set(['NO_CONSENT', 'OPTED_OUT', 'TOO_MANY_PENDING', 'LEAD_NOT_FOUND', 'NOT_PENDING', 'INVALID_INPUT']);
function dbError(e: unknown): Response {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  if (err.code === '42501') return fail('FORBIDDEN', 403);
  if (err.code === '22023' && typeof err.message === 'string') {
    const m = err.message.trim();
    return fail(DB_MESSAGES.has(m) ? m : 'INVALID_INPUT', 422);
  }
  return fail('DB_UNAVAILABLE', 503); // 그 밖의 오류는 원문 없이 닫힘
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CHANNELS = ['phone', 'sms', 'alimtalk'] as const;
const REASONS = ['NEW_UNTOUCHED', 'RECONTACT_OVERDUE', 'FOLLOWUP_OPEN'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const realDate = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const ymd = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return typeof v === 'string' && DATE.test(v.slice(0, 10)) ? v.slice(0, 10) : null;
};
const iso = (v: unknown): string | null => {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};
const masked = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 ? v : null);
const kstToday = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

type DueItem = { scheduleId: number; leadId: string; nameMasked: string | null; interest: string | null; channel: string; dueOn: string; overdue: boolean };
type UnhandledItem = { leadId: string; nameMasked: string | null; interest: string | null; reason: string; since: string };

function pickDue(r: unknown): DueItem | null {
  if (!isObj(r)) return null;
  const id = Number(r.schedule_id);
  const due = ymd(r.due_on);
  if (!Number.isSafeInteger(id) || id < 1 || typeof r.lead_id !== 'string' || !UUID.test(r.lead_id) || !CHANNELS.includes(r.channel as never) || !due || typeof r.overdue !== 'boolean') return null;
  return { scheduleId: id, leadId: r.lead_id, nameMasked: masked(r.name_masked), interest: typeof r.interest === 'string' ? r.interest : null, channel: r.channel as string, dueOn: due, overdue: r.overdue };
}
function pickUnhandled(r: unknown): UnhandledItem | null {
  if (!isObj(r)) return null;
  const since = iso(r.since);
  if (typeof r.lead_id !== 'string' || !UUID.test(r.lead_id) || !REASONS.includes(r.reason as never) || !since) return null;
  return { leadId: r.lead_id, nameMasked: masked(r.name_masked), interest: typeof r.interest === 'string' ? r.interest : null, reason: r.reason as string, since };
}

/** GET ?view=due[&date=YYYY-MM-DD] | ?view=unhandled. due는 오늘(한국 날짜)까지 도래한 예약만 DB가 준다 → date는 오늘 이전·오늘만 */
export async function crmList(deps: CrmAdminDeps, req: Request): Promise<Response> {
  const g = await gate(deps); // 닫힘·인증·역할을 먼저(입력 검사 결과로 정보를 주지 않음)
  if (g instanceof Response) return g;
  let view: string | null = null, date: string | null = null, keys: string[] = [];
  try { const p = new URL(req.url).searchParams; view = p.get('view'); date = p.get('date'); keys = [...p.keys()]; } catch { return fail('INVALID_INPUT', 400); }
  if (keys.some((k) => k !== 'view' && k !== 'date') || new Set(keys).size !== keys.length) return fail('INVALID_INPUT', 400);
  if (view !== 'due' && view !== 'unhandled') return fail('INVALID_INPUT', 400);
  if (date !== null && (view !== 'due' || !DATE.test(date) || !realDate(date))) return fail('INVALID_INPUT', 400);
  if (date !== null && date > kstToday(deps.now())) return fail('FUTURE_DATE_UNSUPPORTED', 422);
  try {
    if (view === 'due') {
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select schedule_id, lead_id, name_masked, interest, channel, due_on, overdue from api.recontact_due(${g.actor}::uuid, ${g.session}::uuid, ${g.token})`);
      const items = rows.map(pickDue);
      if (items.some((x) => x === null)) return fail('DB_UNAVAILABLE', 503); // 형태가 틀린 행은 통째로 거부(일부만 보여주지 않음)
      const list = (items as DueItem[]).filter((x) => date === null || x.dueOn === date);
      return json({ ok: true, view, date, items: list }, 200);
    }
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select lead_id, name_masked, interest, reason, since from api.crm_unhandled(${g.actor}::uuid, ${g.session}::uuid, ${g.token})`);
    const items = rows.map(pickUnhandled);
    if (items.some((x) => x === null)) return fail('DB_UNAVAILABLE', 503);
    const counts = Object.fromEntries(REASONS.map((r) => [r, (items as UnhandledItem[]).filter((x) => x.reason === r).length]));
    return json({ ok: true, view, counts, items }, 200);
  } catch (e) {
    return dbError(e);
  }
}

/** POST {action:'schedule', leadId, dueOn, channel} | {action:'close', scheduleId, status} | {action:'sweep'} */
export async function crmAction(deps: CrmAdminDeps, body: unknown): Promise<Response> {
  const g = await gate(deps);
  if (g instanceof Response) return g;
  if (!isObj(body) || typeof body.action !== 'string') return fail('INVALID_INPUT', 400);
  const b = body;
  if (b.action === 'schedule') {
    if (!exact(b, ['action', 'leadId', 'dueOn', 'channel']) || typeof b.leadId !== 'string' || !UUID.test(b.leadId)
      || typeof b.dueOn !== 'string' || !DATE.test(b.dueOn) || !realDate(b.dueOn) || !CHANNELS.includes(b.channel as never)) return fail('INVALID_INPUT', 400);
  } else if (b.action === 'close') {
    if (!exact(b, ['action', 'scheduleId', 'status']) || typeof b.scheduleId !== 'number' || !Number.isSafeInteger(b.scheduleId) || b.scheduleId < 1
      || (b.status !== 'done' && b.status !== 'cancelled')) return fail('INVALID_INPUT', 400);
  } else if (b.action === 'sweep') {
    if (!exact(b, ['action'])) return fail('INVALID_INPUT', 400);
  } else {
    return fail('INVALID_INPUT', 400);
  }
  try {
    if (b.action === 'schedule') {
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.recontact_schedule(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.leadId as string}::uuid, ${b.dueOn as string}::date, ${b.channel as string}) as r`);
      const r = isObj(rows[0]) ? rows[0].r : null;
      if (r !== 'scheduled' && r !== 'exists') return fail('DB_UNAVAILABLE', 503);
      return json({ ok: true, result: r }, r === 'scheduled' ? 201 : 200);
    }
    if (b.action === 'close') {
      await deps.runInTransaction(async (tx) => tx`select api.recontact_close(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.scheduleId as number}::bigint, ${b.status as string})`);
      return json({ ok: true }, 200);
    }
    const rows = await deps.runInTransaction(async (tx) => tx`select api.recontact_sweep(${g.actor}::uuid, ${g.session}::uuid, ${g.token}) as n`);
    const n = isObj(rows[0]) ? Number(rows[0].n) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) return fail('DB_UNAVAILABLE', 503);
    return json({ ok: true, blocked: n }, 200);
  } catch (e) {
    return dbError(e);
  }
}
