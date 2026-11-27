import 'server-only';
import { gate, type CrmAdminDeps } from './crmAdmin';

/**
 * 설치·정산·환수 관리자 API (PM 11/27 CRM ⑤). DB 함수(0069)를 부르기만 한다.
 * - 대표(owner)만. 닫힘·인증·역할 관문은 CRM과 같다(crmAdmin.gate). DB가 한 번 더 막는다.
 * - 상태 순서·환수 위험 판정·정산 추가 전용은 DB가 최종.
 * - 금액은 DB에만 저장되고 응답에만 담긴다(로그·감사 기록에 금액 없음). 이름은 가린 값만.
 */
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' } as const;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (code: string, status: number) => json({ ok: false, code }, status);

const DB_MESSAGES = new Set(['LEAD_NOT_CONVERTED', 'CONTRACT_TRANSITION', 'INVALID_INPUT']);
function dbError(e: unknown): Response {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  if (err.code === '42501') return fail('FORBIDDEN', 403);
  if (err.code === '22023' && typeof err.message === 'string') {
    const m = err.message.trim();
    return fail(DB_MESSAGES.has(m) ? m : 'INVALID_INPUT', 422);
  }
  return fail('DB_UNAVAILABLE', 503);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const CARRIERS = ['KT', 'SKB', 'LGU', 'OTHER'] as const;
export const CONTRACT_STATUSES = ['scheduled', 'installed', 'cancelled', 'terminated'] as const;
export const CONTRACT_FILTERS = ['all', 'scheduled', 'installed', 'terminated', 'cancelled', 'clawback_risk'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const realDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const ymd = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return typeof v === 'string' && DATE.test(v.slice(0, 10)) ? v.slice(0, 10) : null;
};
const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

export type ContractItem = {
  leadId: string; nameMasked: string | null; carrier: string; status: string;
  installScheduledOn: string; installedOn: string | null; terminatedOn: string | null; contractMonths: number;
  clawbackUntil: string | null; receivedKrw: number; clawbackKrw: number; clawbackRisk: boolean;
};

function pick(r: unknown): ContractItem | null {
  if (!isObj(r)) return null;
  const sched = ymd(r.install_scheduled_on);
  const rec = Number(r.received_krw), cb = Number(r.clawback_krw), months = Number(r.contract_months);
  if (typeof r.lead_id !== 'string' || !UUID.test(r.lead_id) || !CARRIERS.includes(r.carrier as never) || !CONTRACT_STATUSES.includes(r.status as never)
    || !sched || !Number.isSafeInteger(rec) || rec < 0 || !Number.isSafeInteger(cb) || cb < 0 || !Number.isSafeInteger(months)
    || typeof r.clawback_risk !== 'boolean') return null;
  return {
    leadId: r.lead_id, nameMasked: typeof r.name_masked === 'string' && r.name_masked.length <= 40 ? r.name_masked : null,
    carrier: r.carrier as string, status: r.status as string, installScheduledOn: sched,
    installedOn: ymd(r.installed_on), terminatedOn: ymd(r.terminated_on), contractMonths: months,
    clawbackUntil: ymd(r.clawback_until), receivedKrw: rec, clawbackKrw: cb, clawbackRisk: r.clawback_risk,
  };
}

/** GET ?filter=all|scheduled|installed|terminated|cancelled|clawback_risk */
export async function contractList(deps: CrmAdminDeps, req: Request): Promise<Response> {
  const g = await gate(deps);
  if (g instanceof Response) return g;
  let filter: string | null = null, keys: string[] = [];
  try { const p = new URL(req.url).searchParams; filter = p.get('filter'); keys = [...p.keys()]; } catch { return fail('INVALID_INPUT', 400); }
  if (keys.length !== 1 || keys[0] !== 'filter' || !CONTRACT_FILTERS.includes(filter as never)) return fail('INVALID_INPUT', 400);
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select lead_id, name_masked, carrier, status, install_scheduled_on, installed_on, terminated_on, contract_months, clawback_until, received_krw, clawback_krw, clawback_risk from api.contract_list(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${filter as string})`);
    const items = rows.map(pick);
    if (items.some((x) => x === null)) return fail('DB_UNAVAILABLE', 503);
    const list = items as ContractItem[];
    return json({ ok: true, filter, items: list, risk: list.filter((x) => x.clawbackRisk).length }, 200);
  } catch (e) {
    return dbError(e);
  }
}

/**
 * POST {action:'schedule', leadId, carrier, installOn, contractMonths, clawbackMonths}
 *    | {action:'status', leadId, status:'installed'|'terminated', on} | {action:'status', leadId, status:'cancelled'}
 *    | {action:'settle', leadId, kind:'received'|'clawback', amountKrw, on}
 */
export async function contractAction(deps: CrmAdminDeps, body: unknown): Promise<Response> {
  const g = await gate(deps);
  if (g instanceof Response) return g;
  if (!isObj(body) || typeof body.action !== 'string' || typeof body.leadId !== 'string' || !UUID.test(body.leadId)) return fail('INVALID_INPUT', 400);
  const b = body;
  const lead = b.leadId as string;
  try {
    if (b.action === 'schedule') {
      if (!exact(b, ['action', 'leadId', 'carrier', 'installOn', 'contractMonths', 'clawbackMonths']) || !CARRIERS.includes(b.carrier as never)
        || !realDate(b.installOn) || !int(b.contractMonths, 1, 60) || !int(b.clawbackMonths, 0, 60)) return fail('INVALID_INPUT', 400);
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.contract_schedule(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${lead}::uuid, ${b.carrier as string}, ${b.installOn as string}::date, ${b.contractMonths as number}::int, ${b.clawbackMonths as number}::int) as r`);
      const r = isObj(rows[0]) ? rows[0].r : null;
      if (r !== 'scheduled' && r !== 'updated') return fail('DB_UNAVAILABLE', 503);
      return json({ ok: true, result: r }, r === 'scheduled' ? 201 : 200);
    }
    if (b.action === 'status') {
      const cancel = b.status === 'cancelled';
      if (cancel ? !exact(b, ['action', 'leadId', 'status']) : (!exact(b, ['action', 'leadId', 'status', 'on']) || (b.status !== 'installed' && b.status !== 'terminated') || !realDate(b.on))) return fail('INVALID_INPUT', 400);
      const on = cancel ? null : (b.on as string);
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.contract_status(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${lead}::uuid, ${b.status as string}, ${on}::date) as r`);
      const r = isObj(rows[0]) ? rows[0].r : null;
      if (!['installed', 'cancelled', 'clawback_risk', 'no_clawback'].includes(r as string)) return fail('DB_UNAVAILABLE', 503);
      return json({ ok: true, result: r }, 200);
    }
    if (b.action === 'settle') {
      if (!exact(b, ['action', 'leadId', 'kind', 'amountKrw', 'on']) || (b.kind !== 'received' && b.kind !== 'clawback')
        || !int(b.amountKrw, 1, 10_000_000) || !realDate(b.on)) return fail('INVALID_INPUT', 400);
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.settlement_record(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${lead}::uuid, ${b.kind as string}, ${b.amountKrw as number}::int, ${b.on as string}::date) as id`);
      const id = isObj(rows[0]) ? Number(rows[0].id) : NaN;
      if (!Number.isSafeInteger(id) || id < 1) return fail('DB_UNAVAILABLE', 503);
      return json({ ok: true, id }, 201);
    }
    return fail('INVALID_INPUT', 400);
  } catch (e) {
    return dbError(e);
  }
}
