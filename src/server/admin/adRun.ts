import 'server-only';
import { AD_DAILY_CAP_KRW } from '../advertising/budgetGuard';
import { callPlatform, platformDailyBudgetFor } from '../advertising/platform';
import { selectAdPlatform } from '../advertising/platformSelect';
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
/** 라우트가 광고 서버 모듈을 직접 import하지 않도록 이 모듈이 어댑터 선택을 감싼다(AD_PLATFORM=mock 또는 설정이 모두 갖춰진 google_ads, platformSelect) */
export const adRunPlatform = (env: Readonly<Record<string, string | undefined>>): AdPlatform | null => selectAdPlatform(env);

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
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function adRunAction(deps: AdRunDeps, body: unknown): Promise<Response> {
  const action = isObj(body) ? body.action : undefined;
  if (action !== 'launch' && action !== 'collect' && action !== 'alert_resolve' && action !== 'pause' && action !== 'launch_resolve') return adFail('INVALID_ACTION', 400);
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
  if (action === 'launch_resolve') {
    // 집행 여부 불명(unknown)·미완료(requested) launch를 사람이 확인한 뒤 정리한다(대표 전용). 자동 재launch는 없다
    if (!exact(b, ['action', 'requestKey', 'outcome', 'externalId', 'reason']) || typeof b.requestKey !== 'string' || !REQ_KEY.test(b.requestKey)
        || (b.outcome !== 'not_executed' && b.outcome !== 'executed') || (b.externalId !== null && (typeof b.externalId !== 'string' || b.externalId.length < 1 || b.externalId.length > 100))
        || (b.outcome === 'executed' && b.externalId === null) || typeof b.reason !== 'string' || b.reason.trim().length < 2 || b.reason.trim().length > 500) return adFail('INVALID_INPUT', 422);
    try {
      await deps.runInTransaction(async (tx) => tx`select api.ad_launch_resolve(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.requestKey as string}, ${b.outcome as string}, ${b.externalId as string | null}, ${(b.reason as string).trim()})`);
      return adJson({ ok: true }, 200);
    } catch (e) { return adDbError(e); }
  }
  if (action === 'pause') {
    // 수동 중지(대표 전용): DB 승인 철회 → 플랫폼 pause(externalId) → 실패 시 경고. 플랫폼은 승인 amountKrw 이하의 일 예산 상한을 이미 갖고 있다(어댑터 계약)
    if (!exact(b, ['action', 'campaign', 'reason']) || typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign) || typeof b.reason !== 'string' || b.reason.trim().length < 2 || b.reason.trim().length > 500) return adFail('INVALID_INPUT', 422);
    if (!platform) return adFail('PLATFORM_UNAVAILABLE', 503);
    return adJson({ ok: true, ...(await stopCampaign(deps, g, platform, b.campaign, `수동 중지: ${b.reason.trim()}`.slice(0, 500), 'manual')) }, 200);
  }
  if (action === 'launch') {
    if (!platform) return adBlock('PLATFORM_UNAVAILABLE', 503);
    let live = platform.live;
    try { if (live && deps.env().AD_EXECUTION_ENABLED !== 'true') return adBlock('EXECUTION_DISABLED', 403); } catch { return adBlock('EXECUTION_DISABLED', 403); }
    live = platform.live;
    if (!exact(b, ['action', 'campaign', 'amountKrw', 'requestKey'])
        || typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign) || !isInt(b.amountKrw, 1, AD_DAILY_CAP_KRW) || typeof b.requestKey !== 'string' || !REQ_KEY.test(b.requestKey)) return adBlock('INVALID_INPUT', 422);
    const campaign = b.campaign, amountKrw = b.amountKrw, requestKey = b.requestKey;
    // 매체 일예산 = 승인액 ÷ 2(Google 하루 최대 2배 지출 반영). 1원 미만이면 집행하지 않는다
    const platformBudgetKrw = platformDailyBudgetFor(amountKrw);
    if (platformBudgetKrw < 1) return adBlock('INVALID_INPUT', 422);
    // 0) 실제 플랫폼: 계정에 이미 노출 가능한 캠페인이 있으면(FIDEON 밖에서 만든 것 포함) 집행 차단. 조회 실패·형식 오류도 차단(fail-closed). DB·원장 미변경
    if (live) {
      const ext = await callPlatform((deadlineAt) => platform.activeCampaignCount({ deadlineAt }));
      if (ext.status !== 'success' || !isInt(ext.value, 0, 10_000)) return adJson({ ok: false, decision: 'BLOCK', reason: 'EXTERNAL_CHECK_FAILED' }, 503);
      if (ext.value > 0) return adJson({ ok: false, decision: 'BLOCK', reason: 'EXTERNAL_ACTIVE_CAMPAIGN' }, 409);
      // 계정 시간대가 Asia/Seoul이 아니면 종료일·날짜 경계가 어긋난다 → 집행 금지(조회 실패도 금지)
      const tz = await callPlatform((deadlineAt) => platform.accountTimeZone({ deadlineAt }));
      if (tz.status !== 'success') return adJson({ ok: false, decision: 'BLOCK', reason: 'ACCOUNT_CHECK_FAILED' }, 503);
      if (tz.value !== 'Asia/Seoul') return adJson({ ok: false, decision: 'BLOCK', reason: 'ACCOUNT_TIMEZONE_MISMATCH' }, 409);
      // 계정 통화가 KRW가 아니면 예산·한도·CPC 단위가 어긋난다 → 집행 금지(조회 실패도 금지)
      const cur = await callPlatform((deadlineAt) => platform.accountCurrency({ deadlineAt }));
      if (cur.status !== 'success') return adJson({ ok: false, decision: 'BLOCK', reason: 'ACCOUNT_CHECK_FAILED' }, 503);
      if (cur.value !== 'KRW') return adJson({ ok: false, decision: 'BLOCK', reason: 'ACCOUNT_CURRENCY_MISMATCH' }, 409);
    }
    const dbErr = (e: unknown) => { const code = (e as { code?: string })?.code; return adBlock(code === '42501' ? 'FORBIDDEN' : 'ERROR', code === '42501' ? 403 : 503); };
    // 1) launch 시작 기록: 캠페인당 열린 launch 1건·같은 요청 키 1회. 막히면 지출 판정·플랫폼 호출 0회
    try {
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.ad_launch_begin(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign}, ${requestKey}, ${amountKrw}::int) as r`);
      const r = (rows as readonly { r?: unknown }[])[0]?.r;
      if (!isObj(r) || typeof r.ok !== 'boolean') return adBlock('ERROR', 502);
      if (r.ok !== true) return adJson({ ok: false, decision: 'BLOCK', reason: typeof r.reason === 'string' ? r.reason : 'ERROR' }, 200);
    } catch (e) { return dbErr(e); }
    const finish = (state: 'active' | 'failed' | 'unknown', externalId: string | null, note: string | null) =>
      deps.runInTransaction(async (tx) => tx`select api.ad_launch_finish(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${requestKey}, ${state}, ${externalId}, ${note})`);
    // 2) DB 예산 판정(0021: 집행 종료일을 DB가 정하고, 기간 전체 날짜별 최대 청구액으로 캠페인·계정 한도·정기 감시 상태를 판정). 막히면 launch는 failed(집행 안 됨 확실)로 닫는다. 기록이 실패하면 requested로 남아 재launch를 막는다(보수적)
    let decision: Record<string, unknown>;
    try {
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.ad_spend_request_window(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign}, ${amountKrw}::int, ${requestKey}) as r`);
      const r = (rows as readonly { r?: unknown }[])[0]?.r;
      if (!isObj(r) || (r.decision !== 'ALLOW' && r.decision !== 'BLOCK')) { await finish('failed', null, 'SPEND_ERROR').catch(() => undefined); return adBlock('ERROR', 502); }
      decision = r;
    } catch (e) {
      await finish('failed', null, 'SPEND_ERROR').catch(() => undefined);
      return dbErr(e);
    }
    if (decision.decision !== 'ALLOW') {
      await finish('failed', null, 'SPEND_BLOCKED').catch(() => undefined);
      return adJson({ ok: false, decision: 'BLOCK', reason: decision.reason ?? 'ERROR' }, 200);
    }
    // 종료일은 DB 값만 쓴다: 형식·범위(오늘~오늘+2, KST)가 맞지 않으면 집행하지 않는다
    const today = kstDay(deps.now());
    const endDate = decision.end_date;
    if (typeof endDate !== 'string' || !realDay(endDate) || endDate < today || endDate > addDays(today, 2)) {
      await finish('failed', null, 'WINDOW_INVALID').catch(() => undefined);
      return adJson({ ok: false, decision: 'BLOCK', reason: 'WINDOW_INVALID', spendRecorded: true }, 502);
    }
    // 3) 플랫폼 호출(시간 제한·플랫폼 일 예산 상한 = 승인액 ÷ 2·종료일). 결과는 success / failed / unknown
    const res = await callPlatform((deadlineAt) => platform.launch({ campaign, amountKrw, requestKey, platformDailyBudgetKrw: platformBudgetKrw, endDate, deadlineAt }));
    if (res.status === 'failed') {
      await finish('failed', null, res.code).catch(() => undefined);
      // 지출은 원장에 이미 기록됐다(보수적: 집행 안 됨이 확실해도 되돌리지 않는다)
      return adJson({ ok: false, decision: 'BLOCK', reason: 'PLATFORM_ERROR', outcome: 'failed', spendRecorded: true }, 502);
    }
    if (res.status === 'unknown') {
      // 집행 여부 불명: 자동 재launch 금지. unknown으로 저장하고 사람이 확인(launch_resolve)한 뒤에만 다시 시도한다
      let saved = true;
      try { await finish('unknown', null, res.code); } catch { saved = false; }
      return adJson({ ok: false, decision: 'BLOCK', reason: 'PLATFORM_UNKNOWN', outcome: 'unknown', spendRecorded: true, needsReview: true, stateSaved: saved }, 502);
    }
    const out = res.value as { externalId?: unknown; dailyBudgetKrw?: unknown } | undefined;
    if (typeof out?.externalId !== 'string' || out.externalId.length < 1 || out.externalId.length > 100) {
      try { await finish('unknown', null, 'BAD_RESPONSE'); } catch { /* requested로 남아 재launch 차단 */ }
      return adJson({ ok: false, decision: 'BLOCK', reason: 'PLATFORM_UNKNOWN', outcome: 'unknown', spendRecorded: true, needsReview: true }, 502);
    }
    const externalId = out.externalId;
    try { await finish('active', externalId, null); } catch {
      // 플랫폼은 집행됐는데 상태 저장이 실패: externalId를 응답에 돌려주고(비밀 아님) requested로 남겨 재launch를 막는다. 대표가 launch_resolve(executed)로 정리한다
      return adJson({ ok: false, decision: 'BLOCK', reason: 'LAUNCH_STATE_UNSAVED', outcome: 'success', spendRecorded: true, needsReview: true, externalId }, 502);
    }
    // 플랫폼 일 예산 상한이 승인액 ÷ 2 이하가 아니면 계약 위반: 즉시 중지·경고(철회 → pause → 경고)
    if (!isInt(out.dailyBudgetKrw, 1, platformBudgetKrw)) {
      const stop = await stopCampaign(deps, g, platform, campaign, '플랫폼 일 예산 상한이 승인 금액 이하가 아님 — 자동 중지', 'budget_cap_violation');
      return adJson({ ok: false, decision: 'BLOCK', reason: 'PLATFORM_BUDGET_NOT_PROTECTED', spendRecorded: true, externalId, autoStop: stop }, 502);
    }
    // 매체 종료일·계정 시간대를 다시 읽어 확인하지 못하면(불일치·미확인) 즉시 중지·집행 금지
    if ((out as { endVerified?: unknown }).endVerified !== true) {
      const stop = await stopCampaign(deps, g, platform, campaign, '매체 종료일 확인 실패 — 자동 중지', 'end_date_unverified');
      return adJson({ ok: false, decision: 'BLOCK', reason: 'END_DATE_NOT_VERIFIED', spendRecorded: true, externalId, autoStop: stop }, 502);
    }
    return adJson({ ok: true, decision: 'ALLOW', executed: live, simulated: !live, externalId, platformDailyBudgetKrw: out.dailyBudgetKrw, endDate }, 200);
  }
  // collect
  if (!exact(b, ['action', 'campaign', 'day']) || typeof b.campaign !== 'string' || !CAMPAIGN.test(b.campaign) || typeof b.day !== 'string' || !realDay(b.day)) return adFail('INVALID_INPUT', 422);
  if (!platform) return adFail('PLATFORM_UNAVAILABLE', 503);
  if (b.day > kstDay(deps.now())) return adFail('INVALID_INPUT', 422);
  const cur = await currentLaunch(deps, g, b.campaign);
  if (cur === 'ERROR') return adFail('DB_UNAVAILABLE', 503);
  // 실제 플랫폼은 저장된 externalId가 있는 launch(active·paused)만 조회한다. 모의는 launch 없이도 가상 값을 돌려준다
  if (platform.live && (cur === null || (cur.state !== 'active' && cur.state !== 'paused') || cur.externalId === null)) return adFail(cur?.state === 'unknown' || cur?.state === 'requested' ? 'LAUNCH_UNKNOWN' : 'NO_ACTIVE_LAUNCH', 409);
  const ref = { campaign: b.campaign, externalId: cur === null ? null : cur.externalId };
  const pr = await callPlatform((deadlineAt) => platform.fetchPerformance(ref, b.day as string, { deadlineAt }));
  if (pr.status !== 'success') return adFail('PLATFORM_ERROR', 502);
  const perf: unknown = pr.value;
  // 보고 지연(성과 행 없음): 0원으로 기록하지 않고 UNKNOWN으로 돌려준다(초과를 0으로 숨기지 않음). 원장·성과 미기록
  if (isObj(perf) && perf.costKrw === null) return adJson({ ok: false, recorded: false, spend: 'UNKNOWN', reason: 'SPEND_UNKNOWN' }, 202);
  if (!isObj(perf) || !isInt(perf.impressions, 0, 100_000_000) || !isInt(perf.clicks, 0, 100_000_000) || !isInt(perf.costKrw, 0, 100_000) || (perf.clicks as number) > (perf.impressions as number)) return adFail('PLATFORM_DATA_INVALID', 502);
  const source = platform.live ? 'platform' : 'mock';
  try {
    const rows = await deps.runInTransaction(async (tx) =>
      tx`select api.ad_performance_record(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${b.campaign as string}, ${b.day as string}::date, ${perf.impressions as number}::int, ${perf.clicks as number}::int, ${perf.costKrw as number}::int, ${source}) as r`);
    const r = (rows as readonly { r?: unknown }[])[0]?.r;
    if (!isObj(r) || typeof r.recorded !== 'boolean') return adFail('INVALID_DATA', 502);
    const over = r.recorded === true && r.over_ledger === true;
    const autoStop = over ? await stopCampaign(deps, g, platform, b.campaign as string, '광고비 초과 감지 자동 중지', 'overspend') : undefined;
    return adJson({ ok: true, recorded: r.recorded, overLedger: r.over_ledger ?? null, source, ...(autoStop ? { autoStop } : {}) }, 200);
  } catch (e) { return adDbError(e); }
}

type Cur = { state: string; externalId: string | null; amountKrw: number | null };
/** 캠페인의 현재 launch(열린 것 우선, 없으면 최근 paused). 없으면 null, 조회 실패는 'ERROR' */
async function currentLaunch(deps: AdRunDeps, g: StaffIdentity, campaign: string): Promise<Cur | null | 'ERROR'> {
  try {
    const rows = await deps.runInTransaction(async (tx) => tx`select api.ad_launch_active(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign}) as r`);
    const r = (rows as readonly { r?: unknown }[])[0]?.r;
    if (r === null || r === undefined) return null;
    if (!isObj(r) || typeof r.state !== 'string') return 'ERROR';
    return { state: r.state, externalId: typeof r.external_id === 'string' ? r.external_id : null, amountKrw: typeof r.amount_krw === 'number' ? r.amount_krw : null };
  } catch { return 'ERROR'; }
}

/**
 * 중지(초과 감지 자동·수동 공통): ① DB 승인 철회(이후 모든 새 지출 차단) → ② 플랫폼 pause(externalId, 시간 제한) → ③ 하나라도 끝나지 않으면 경고.
 * pause가 실패해도 플랫폼 쪽 일 예산 상한(어댑터 계약: 승인 amountKrw 이하)이 추가 피해를 제한한다. 각 단계 결과를 숨기지 않는다.
 */
async function stopCampaign(deps: AdRunDeps, g: StaffIdentity, platform: AdPlatform, campaign: string, reason: string, trigger: 'overspend' | 'manual' | 'budget_cap_violation' | 'end_date_unverified') {
  let revoked = false;
  let revokeNote: string | null = null;
  try {
    await deps.runInTransaction(async (tx) =>
      tx`select api.ad_budget_revoke(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign}, ${reason})`);
    revoked = true;
  } catch (e) {
    // 승인이 이미 없으면(NO_ACTIVE_APPROVAL) 지출은 이미 막혀 있다
    revokeNote = (e as { code?: string })?.code === '22023' ? 'NO_ACTIVE_APPROVAL' : 'REVOKE_FAILED';
  }
  const cur = await currentLaunch(deps, g, campaign);
  let paused = false;
  let pauseNote: string | null = null;
  if (cur === 'ERROR') pauseNote = 'LAUNCH_LOOKUP_FAILED';
  else if (cur !== null && cur.state === 'paused') paused = true;
  else if (cur === null) { if (platform.live) paused = true; /* 집행 기록이 없으면 멈출 것이 없다 */ else { const r = await callPlatform((deadlineAt) => platform.pause({ campaign, externalId: null }, { deadlineAt })); paused = r.status === 'success' && r.value?.paused === true; } }
  else if (cur.externalId === null) pauseNote = 'EXTERNAL_ID_UNKNOWN'; // requested·unknown: 플랫폼 캠페인을 특정할 수 없다 → 사람이 확인
  else {
    const r = await callPlatform((deadlineAt) => platform.pause({ campaign, externalId: cur.externalId }, { deadlineAt }));
    paused = r.status === 'success' && r.value?.paused === true;
    if (!paused) pauseNote = r.status === 'success' ? 'NOT_PAUSED' : r.code;
    if (paused && cur.state === 'active') { try { await deps.runInTransaction(async (tx) => tx`select api.ad_launch_paused(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign})`); } catch { /* 중지는 됐다. 기록만 남지 않음 */ } }
  }
  // 끝까지 중지되지 않았으면(철회 실패 또는 플랫폼 중지 실패) 관리자 경고를 연다. 경고가 열려 있는 동안 DB가 지출·새 승인을 막는다
  const complete = (revoked || revokeNote === 'NO_ACTIVE_APPROVAL') && paused;
  let alert: { opened: boolean } | null = null;
  if (!complete) {
    alert = { opened: false };
    try {
      const rows = await deps.runInTransaction(async (tx) =>
        tx`select api.ad_alert_open(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${campaign}, ${JSON.stringify({ revoked, revokeNote, paused, pauseNote, simulated: !platform.live, trigger, platformCapKrw: cur !== 'ERROR' && cur !== null ? cur.amountKrw : null })}::text::jsonb) as id`);
      const id = (rows as readonly { id?: unknown }[])[0]?.id;
      alert = { opened: typeof id === 'string' && UUID.test(id) };
    } catch { alert = { opened: false }; }
  }
  return { revoked, revokeNote, paused, pauseNote, simulated: !platform.live, alert };
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
