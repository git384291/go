import 'server-only';
import { AD_DAILY_CAP_KRW } from '../advertising/budgetGuard';
import { createPlatform } from '../advertising/platform';
import type { AdPlatform } from '../advertising/platform';
import { adBlock, adDbError, adFail, adGate, adJson } from './adBudget';
import type { AdBudgetDeps, SqlTag } from './adBudget';
import type { StaffIdentity } from '../auth/staffSession';

/**
 * 광고 집행 요청·성과 수집·전환 분석 (PM 11/21). 모든 판정은 서버가 한다 — 화면 버튼·클라이언트 값은 믿지 않는다.
 * 집행(launch) 순서: 대표 권한 → 플랫폼 있음 → (실제 플랫폼이면 AD_EXECUTION_ENABLED=true 필요, 기본 꺼짐) → DB 예산 판정(승인·한도·중복) → 플랫폼 호출.
 *  어느 단계든 막히거나 오류면 BLOCK이고 플랫폼은 불리지 않는다. 모의 어댑터는 과금·집행이 없다(executed=false).
 * 성과 수집(collect): 플랫폼이 준 값은 형식을 다시 검사하고, 보고 광고비가 그날 승인 원장보다 크면 DB가 over_ledger로 표시하고 감사 기록을 남긴다.
 *  초과가 감지되면 자동 중지한다: ① 승인 철회(이후 모든 지출 차단) ② 플랫폼 중지 요청. 철회가 먼저이고, 어느 쪽이 실패해도 다른 쪽은 진행하며 결과를 응답에 그대로 알린다.
 * 분석(funnel): 노출→클릭→상담 시작→접수 건수와 광고비만 센다(개인정보 읽기 없음).
 */
/** 라우트가 광고 서버 모듈을 직접 import하지 않도록 이 모듈이 어댑터 선택을 감싼다(AD_PLATFORM=mock만) */
export const adRunPlatform = (env: Readonly<Record<string, string | undefined>>): AdPlatform | null => createPlatform(env);

export type AdRunDeps = AdBudgetDeps & { platform: AdPlatform | null };

const CAMPAIGN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REQ_KEY = /^[A-Za-z0-9-]{16,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const realDay = (s: string) => { if (!DAY.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export async function adRunAction(deps: AdRunDeps, body: unknown): Promise<Response> {
  const action = isObj(body) ? body.action : undefined;
  if (action !== 'launch' && action !== 'collect' && action !== 'alert_resolve') return adFail('INVALID_ACTION', 400);
  const g = await adGate(deps, action);
  if (g instanceof Response) return action === 'launch' ? adBlock(await g.clone().json().then((j: { code?: string }) => j.code ?? 'ERROR').catch(() => 'ERROR'), g.status) : g;
  const b = body as Record<string, unknown>;
  if (action === 'alert_resolve') {
    if (!exact(b, ['action', 'id', 'note']) || typeof b.id !== 'string' || !UUID.test(b.id) || typeof b.note !== 'string' || b.note.trim().length < 2 || b.note.trim().length > 500) return adFail('INVALID_INPUT', 422);
    try {
      await deps.runInTransaction(async (tx) => tx`select api.ad_alert_resolve(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.id as string}::uuid, ${(b.note as string).trim()})`);
      return adJson({ ok: true }, 200);
    } catch (e) { return adDbError(e); }
  }
  const platform = deps.platform;
  if (action === 'launch') {
    if (!platform) return adBlock('PLATFORM_UNAVAILABLE', 503);
    let live = platform.live;
    try { if (live && deps.env().AD_EXECUTION_ENABLED !== 'true') return adBlock('EXECUTION_DISABLED', 403); } catch { return adBlock('EXECUTION_DISABLED', 403); }
    live = platform.live;
    if (!exact(b, ['action', 'campaign', 'amountKrw', 'requestKey'])
        || typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign) || !isInt(b.amountKrw, 1, AD_DAILY_CAP_KRW) || typeof b.requestKey !== 'string' || !REQ_KEY.test(b.requestKey)) return adBlock('INVALID_INPUT', 422);
    let decision: Record<string, unknown>;
    try {
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.ad_spend_request(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.campaign as string}, ${b.amountKrw as number}::int, ${b.requestKey as string}) as r`);
      const r = (rows as readonly { r?: unknown }[])[0]?.r;
      if (!isObj(r) || (r.decision !== 'ALLOW' && r.decision !== 'BLOCK')) return adBlock('ERROR', 502);
      decision = r;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      return adBlock(code === '42501' ? 'FORBIDDEN' : 'ERROR', code === '42501' ? 403 : 503);
    }
    if (decision.decision !== 'ALLOW') return adJson({ ok: false, decision: 'BLOCK', reason: decision.reason ?? 'ERROR' }, 200);
    try {
      const out = await platform.launch({ campaign: b.campaign, amountKrw: b.amountKrw, requestKey: b.requestKey });
      if (typeof out?.externalId !== 'string' || out.externalId.length > 100) return adJson({ ok: false, decision: 'BLOCK', reason: 'PLATFORM_ERROR', spendRecorded: true }, 502);
      return adJson({ ok: true, decision: 'ALLOW', executed: live, simulated: !live, externalId: out.externalId }, 200);
    } catch {
      // 판정은 이미 원장에 기록됐다(보수적: 실제 집행 여부를 모르면 지출로 센다)
      return adJson({ ok: false, decision: 'BLOCK', reason: 'PLATFORM_ERROR', spendRecorded: true }, 502);
    }
  }
  // collect
  if (!exact(b, ['action', 'campaign', 'day']) || typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign) || typeof b.day !== 'string' || !realDay(b.day)) return adFail('INVALID_INPUT', 422);
  if (!platform) return adFail('PLATFORM_UNAVAILABLE', 503);
  if (b.day > kstDay(deps.now())) return adFail('INVALID_INPUT', 422);
  let perf: unknown;
  try { perf = await platform.fetchPerformance(b.campaign, b.day); } catch { return adFail('PLATFORM_ERROR', 502); }
  if (!isObj(perf) || !isInt(perf.impressions, 0, 100_000_000) || !isInt(perf.clicks, 0, 100_000_000) || !isInt(perf.costKrw, 0, 100_000) || (perf.clicks as number) > (perf.impressions as number)) return adFail('PLATFORM_DATA_INVALID', 502);
  const source = platform.live ? 'platform' : 'mock';
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select api.ad_performance_record(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.campaign as string}, ${b.day as string}::date, ${perf.impressions as number}::int, ${perf.clicks as number}::int, ${perf.costKrw as number}::int, ${source}) as r`);
    const r = (rows as readonly { r?: unknown }[])[0]?.r;
    if (!isObj(r) || typeof r.recorded !== 'boolean') return adFail('INVALID_DATA', 502);
    const over = r.recorded === true && r.over_ledger === true;
    const autoStop = over ? await autoStopCampaign(deps, g, platform, b.campaign as string) : undefined;
    return adJson({ ok: true, recorded: r.recorded, overLedger: r.over_ledger ?? null, source, ...(autoStop ? { autoStop } : {}) }, 200);
  } catch (e) { return adDbError(e); }
}

/** 초과 감지 자동 중지: 승인 철회(DB) → 플랫폼 중지. 각 단계 결과를 숨기지 않는다 */
async function autoStopCampaign(deps: AdRunDeps, g: StaffIdentity, platform: AdPlatform, campaign: string) {
  let revoked = false;
  let revokeNote: string | null = null;
  try {
    await deps.runInTransaction(async (tx) =>
      tx`select api.ad_budget_revoke(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign}, ${'광고비 초과 감지 자동 중지'})`);
    revoked = true;
  } catch (e) {
    // 승인이 이미 없으면(NO_ACTIVE_APPROVAL) 지출은 이미 막혀 있다
    revokeNote = (e as { code?: string })?.code === '22023' ? 'NO_ACTIVE_APPROVAL' : 'REVOKE_FAILED';
  }
  let paused = false;
  try { paused = (await platform.pause(campaign))?.paused === true; } catch { paused = false; }
  // 끝까지 중지되지 않았으면(철회 실패 또는 플랫폼 중지 실패) 관리자 경고를 연다. 경고가 열려 있는 동안 DB가 지출·새 승인을 막는다
  const complete = (revoked || revokeNote === 'NO_ACTIVE_APPROVAL') && paused;
  let alert: { opened: boolean } | null = null;
  if (!complete) {
    alert = { opened: false };
    try {
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.ad_alert_open(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign}, ${JSON.stringify({ revoked, revokeNote, paused, simulated: !platform.live, trigger: 'overspend' })}::text::jsonb) as id`);
      const id = (rows as readonly { id?: unknown }[])[0]?.id;
      alert = { opened: typeof id === 'string' && UUID.test(id) };
    } catch { alert = { opened: false }; }
  }
  return { revoked, revokeNote, paused, simulated: !platform.live, alert };
}

type Row = { campaign_key: string; impressions: string | number; clicks: string | number; cost_krw: string | number; ledger_krw: string | number; consults: string | number; leads: string | number; overspend_days: string | number };
const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);

export async function adFunnel(deps: AdBudgetDeps, req: Request): Promise<Response> {
  const g = await adGate(deps, 'funnel');
  if (g instanceof Response) return g;
  const today = kstDay(deps.now());
  let from = kstDay(new Date(deps.now().getTime() - 6 * 86_400_000));
  let to = today;
  try {
    const p = new URL(req.url).searchParams;
    if (p.has('from')) from = p.get('from') ?? '';
    if (p.has('to')) to = p.get('to') ?? '';
  } catch { return adFail('INVALID_RANGE', 400); }
  if (!realDay(from) || !realDay(to) || to < from || to > today) return adFail('INVALID_RANGE', 400);
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select campaign_key, impressions, clicks, cost_krw, ledger_krw, consults, leads, overspend_days from api.ad_funnel_full(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${from}::date, ${to}::date)`);
    if (!Array.isArray(rows) || rows.length > 200) return adFail('INVALID_DATA', 502);
    const items = (rows as Row[]).map((r) => {
      const v = { impressions: n(r.impressions), clicks: n(r.clicks), costKrw: n(r.cost_krw), ledgerKrw: n(r.ledger_krw), consults: n(r.consults), leads: n(r.leads), overspendDays: n(r.overspend_days) };
      if (typeof r.campaign_key !== 'string' || Object.values(v).some(Number.isNaN)) throw new Error('INVALID_DATA');
      return { campaign: r.campaign_key, ...v, clickRate: ratio(v.clicks, v.impressions), consultRate: ratio(v.consults, v.clicks), leadRate: ratio(v.leads, v.consults), costPerLeadKrw: v.leads > 0 ? Math.round(v.costKrw / v.leads) : null, overBudget: v.overspendDays > 0 };
    });
    // 중지 실패 경고(열린 것 먼저). 조회가 실패해도 분석은 보여 주되 alertsError로 알린다(경고가 없다고 오해하지 않게)
    let alerts: unknown[] = [];
    let alertsError = false;
    try {
      const ar = await deps.runInTransaction(async (tx) =>
        tx`select id, campaign_key, state, detail, created_at, resolved_at, resolve_note from api.ad_alert_list(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${50}::int)`);
      if (!Array.isArray(ar)) throw new Error('x');
      alerts = ar as unknown[];
    } catch { alertsError = true; }
    return adJson({ ok: true, role: g.role, from, to, consultTracked: true, items, alerts, alertsError }, 200);
  } catch (e) {
    if ((e as Error)?.message === 'INVALID_DATA') return adFail('INVALID_DATA', 502);
    return adDbError(e);
  }
}
export type { SqlTag };
