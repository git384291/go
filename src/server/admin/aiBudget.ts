import 'server-only';
import { adDbError, adFail, adGate, adJson } from './adBudget';
import type { AdBudgetDeps } from './adBudget';

/**
 * 관리자 AI 월 비용 한도 (PM 11/21). 조회: 대표·검토자, 설정: 대표만(사유 필수, 상한 100,000원, 감사 기록 — DB가 최종 판정).
 * 한도를 올려도 실제 AI API 어댑터는 없다(별도 승인 전 금지). 기본 한도는 0원.
 */
const MAX_LIMIT_KRW = 100_000;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const exact = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
type Row = { month: unknown; monthly_limit_krw: unknown; used_krw: unknown; unconfirmed_count: unknown };

export async function aiBudgetGet(deps: AdBudgetDeps): Promise<Response> {
  const g = await adGate(deps, 'ai_get');
  if (g instanceof Response) return g;
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select month, monthly_limit_krw, used_krw, unconfirmed_count from api.ai_budget_limit_get(${g.actor}::uuid, ${g.session}::uuid, ${g.token})`);
    const r = (rows as readonly Row[])[0];
    if (!r || typeof r.month !== 'string' || !/^\d{4}-\d{2}$/.test(r.month) || !isInt(r.monthly_limit_krw, 0, 1_000_000) || !isInt(r.used_krw, 0, 100_000_000) || !isInt(r.unconfirmed_count, 0, 100_000_000)) return adFail('INVALID_DATA', 502);
    return adJson({ ok: true, role: g.role, month: r.month, limitKrw: r.monthly_limit_krw, usedKrw: r.used_krw, unconfirmed: r.unconfirmed_count, maxLimitKrw: MAX_LIMIT_KRW }, 200);
  } catch (e) { return adDbError(e); }
}

export async function aiBudgetSet(deps: AdBudgetDeps, body: unknown): Promise<Response> {
  const g = await adGate(deps, 'ai_set');
  if (g instanceof Response) return g;
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || !exact(b, ['limitKrw', 'reason'])) return adFail('INVALID_INPUT', 422);
  if (!isInt(b.limitKrw, 0, MAX_LIMIT_KRW)) return adFail('INVALID_LIMIT', 422);
  if (typeof b.reason !== 'string' || b.reason.trim().length < 2 || b.reason.trim().length > 500) return adFail('REASON_REQUIRED', 422);
  try {
    await deps.runInTransaction(async (tx) =>
      tx`select api.ai_budget_limit_set(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.limitKrw as number}::int, ${(b.reason as string).trim()})`);
    return adJson({ ok: true }, 200);
  } catch (e) { return adDbError(e); }
}
