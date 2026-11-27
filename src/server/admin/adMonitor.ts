import 'server-only';
import { callPlatform, type AdPlatform } from '../advertising/platform';

/**
 * 광고 정기 감시(PM 11/22 P0). 예약 실행(외부 스케줄러 → /api/internal/ad-monitor)이 부른다. 직원 세션 없이 전용 DB 역할(app_ad_monitor)만 쓴다.
 * - 열린 launch마다: 승인 없음·만료, 집행 종료일 경과면 중지. 날짜별 실제 비용(보고값)이 그날 최대 청구액을 넘거나 계정 합계가 3만원 이상이면 중지.
 * - 보고 지연(비용 null)·조회 실패·불명 launch는 UNKNOWN: 실행 기록을 '정상 아님'으로 남겨 새 집행을 막는다(DB: MONITOR_NOT_OK).
 * - 중지는 매체 pause → DB 승인 철회. pause가 실패하면 중지 실패 경고(계정 전체 STOP_PENDING). 실행 자체가 실패하면 기록이 끊겨 2시간 뒤 MONITOR_STALE.
 * - 키·토큰·외부 ID·고객 정보는 결과·기록에 넣지 않는다(캠페인 키와 고정 코드만).
 * - 0034 월 예산: 이번 달(KST) 사용액(DB, 미확정 = 최대 청구 가능액)에 이번 회차 보고값의 초과분을 더해 판정 한도 이상이면,
 *   또는 월 예산 미설정(0원)이면 열린 캠페인 전부 중지(MONTHLY_CAP_REACHED·MONTHLY_BUDGET_UNSET). 월 값이 없거나 형식이 틀리면 대상 조회 실패로 본다.
 */
export type MonitorTx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
export type MonitorDeps = {
  readonly platform: AdPlatform | null;
  readonly now: () => Date;
  readonly runAsMonitor: <T>(fn: (tx: MonitorTx) => Promise<T>) => Promise<T>;
  /** 회차 ID(UUID). 겹친·중복 호출은 DB 시작 기록(0022)으로 거부된다 */
  readonly runId: string;
};
export type MonitorCode =
  | 'NO_ACTIVE_APPROVAL' | 'MONTHLY_CAP_REACHED' | 'MONTHLY_BUDGET_UNSET' | 'APPROVAL_EXPIRED' | 'WINDOW_ENDED' | 'NO_WINDOW' | 'DAY_OVER_MAX' | 'ACCOUNT_TOTAL_REACHED'
  | 'ACCOUNT_TIMEZONE_MISMATCH' | 'ACCOUNT_CURRENCY_MISMATCH' | 'ACCOUNT_CHECK_FAILED' | 'SPEND_UNKNOWN' | 'FETCH_FAILED' | 'LAUNCH_UNKNOWN' | 'PLATFORM_UNAVAILABLE' | 'STOP_FAILED' | 'STOP_RECORD_FAILED' | 'TARGETS_UNAVAILABLE' | 'RECORD_FAILED';
export type MonitorResult = {
  readonly ok: boolean;
  readonly checked: number;
  readonly stopped: readonly { readonly campaign: string; readonly code: MonitorCode; readonly paused: boolean }[];
  readonly unknown: readonly { readonly campaign: string; readonly code: MonitorCode }[];
  readonly recorded: boolean;
  /** 다른 회차가 진행 중이라 이번 호출은 아무것도 하지 않음(중복 실행) */
  readonly busy: boolean;
};

const ACCOUNT_TOTAL_CAP_KRW = 30_000;
const CAMPAIGN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

type Launch = { campaign: string; state: string; externalId: string | null; validUntil: number | null; endDate: string | null; days: { date: string; maxKrw: number }[] };

const isKrw = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function parseTargets(v: unknown): { launches: Launch[]; accountTotal: number; monthUsed: number; monthLimit: number } | null {
  if (!isObj(v) || !Array.isArray(v.launches) || typeof v.account_total_krw !== 'number' || !isKrw(v.month_used_krw) || !isKrw(v.month_limit_krw)) return null;
  const launches: Launch[] = [];
  for (const l of v.launches) {
    if (!isObj(l) || typeof l.campaign !== 'string' || !CAMPAIGN.test(l.campaign) || typeof l.state !== 'string' || !Array.isArray(l.days)) return null;
    const vu = typeof l.valid_until === 'string' ? Date.parse(l.valid_until) : null;
    const days: Launch['days'] = [];
    for (const d of l.days) {
      if (!isObj(d) || typeof d.date !== 'string' || !DAY.test(d.date) || typeof d.max_krw !== 'number' || !Number.isSafeInteger(d.max_krw)) return null;
      days.push({ date: d.date, maxKrw: d.max_krw });
    }
    launches.push({
      campaign: l.campaign, state: l.state, externalId: typeof l.external_id === 'string' ? l.external_id : null,
      validUntil: vu !== null && Number.isFinite(vu) ? vu : null, endDate: typeof l.end_date === 'string' && DAY.test(l.end_date) ? l.end_date : null, days,
    });
  }
  return { launches, accountTotal: v.account_total_krw, monthUsed: v.month_used_krw, monthLimit: v.month_limit_krw };
}

export async function runAdMonitor(deps: MonitorDeps): Promise<MonitorResult> {
  const now = deps.now();
  const today = kstDay(now);
  const stopped: { campaign: string; code: MonitorCode; paused: boolean }[] = [];
  const unknown: { campaign: string; code: MonitorCode }[] = [];
  // 0) 중복·겹친 실행 방지: 시작 기록을 못 잡으면 아무것도 하지 않는다(조회·중지·기록 0회)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deps.runId)) return { ok: false, checked: 0, stopped, unknown: [{ campaign: '-', code: 'TARGETS_UNAVAILABLE' }], recorded: false, busy: false };
  try {
    const rows = await deps.runAsMonitor((tx) => tx`select api.ad_monitor_begin(${deps.runId}::uuid) as r`);
    if ((rows as readonly { r?: unknown }[])[0]?.r !== true) return { ok: false, checked: 0, stopped, unknown: [], recorded: false, busy: true };
  } catch {
    return { ok: false, checked: 0, stopped, unknown: [{ campaign: '-', code: 'TARGETS_UNAVAILABLE' }], recorded: false, busy: false };
  }
  let targets: ReturnType<typeof parseTargets> = null;
  try {
    const rows = await deps.runAsMonitor((tx) => tx`select api.ad_monitor_targets() as r`);
    targets = parseTargets((rows as readonly { r?: unknown }[])[0]?.r);
  } catch { targets = null; }
  if (!targets) {
    // 대상 조회 실패: 기록도 시도하지 않는다(보통 같은 원인) → 기록이 끊겨 2시간 뒤 새 집행 차단
    return { ok: false, checked: 0, stopped, unknown: [{ campaign: '-', code: 'TARGETS_UNAVAILABLE' }], recorded: false, busy: false };
  }
  const platform = deps.platform;
  let knownTotal = 0;
  let monthExtra = 0; // 이번 달 날짜의 보고 비용이 그날 최대 청구액을 넘은 만큼(DB 사용액에 아직 없을 수 있음)
  const month = today.slice(0, 7);
  // 계정 시간대 확인(실제 플랫폼, 열린 launch가 있을 때): Asia/Seoul이 아니면 열린 캠페인 전부 중지, 조회 실패는 UNKNOWN
  let tzBad: MonitorCode | null = null;
  if (platform && platform.live && targets.launches.length > 0) {
    const tz = await callPlatform((deadlineAt) => platform.accountTimeZone({ deadlineAt }));
    if (tz.status !== 'success') unknown.push({ campaign: '-', code: 'ACCOUNT_CHECK_FAILED' });
    else if (tz.value !== 'Asia/Seoul') tzBad = 'ACCOUNT_TIMEZONE_MISMATCH';
    // 계정 통화: KRW가 아니면 열린 캠페인 전부 중지, 조회 실패는 UNKNOWN(새 집행 차단)
    const cur = await callPlatform((deadlineAt) => platform.accountCurrency({ deadlineAt }));
    if (cur.status !== 'success') unknown.push({ campaign: '-', code: 'ACCOUNT_CHECK_FAILED' });
    else if (cur.value !== 'KRW') tzBad = tzBad ?? 'ACCOUNT_CURRENCY_MISMATCH';
  }

  const stop = async (campaign: string, externalId: string | null, code: MonitorCode) => {
    let paused = false;
    if (platform && externalId) {
      const r = await callPlatform((deadlineAt) => platform.pause({ campaign, externalId }, { deadlineAt }));
      paused = r.status === 'success' && isObj(r.value) && r.value.paused === true;
    }
    try {
      await deps.runAsMonitor((tx) => tx`select api.ad_monitor_stop(${campaign}, ${code}, ${paused}) as r`);
    } catch { unknown.push({ campaign, code: 'STOP_RECORD_FAILED' }); }
    if (!paused) unknown.push({ campaign, code: 'STOP_FAILED' });
    stopped.push({ campaign, code, paused });
  };

  for (const l of targets.launches) {
    if (l.state !== 'active' || !l.externalId) { unknown.push({ campaign: l.campaign, code: 'LAUNCH_UNKNOWN' }); continue; }
    if (!platform) { unknown.push({ campaign: l.campaign, code: 'PLATFORM_UNAVAILABLE' }); continue; }
    // 1) 기간·승인: 종료일 경과, 승인 없음·만료, 기간 기록 없음 → 중지
    let code: MonitorCode | null = tzBad;
    if (code) { /* 시간대·통화 불일치: 아래 판정 없이 중지 */ }
    else if (l.days.length === 0 || !l.endDate) code = 'NO_WINDOW';
    else if (l.validUntil === null) code = 'NO_ACTIVE_APPROVAL';
    else if (now.getTime() >= l.validUntil) code = 'APPROVAL_EXPIRED';
    else if (today > l.endDate) code = 'WINDOW_ENDED';
    if (code) { await stop(l.campaign, l.externalId, code); continue; }
    // 2) 날짜별 보고 비용 ≤ 그날 최대 청구액. 보고 없음·조회 실패는 UNKNOWN(새 집행 차단)
    for (const d of l.days.filter((x) => x.date <= today)) {
      const r = await callPlatform((deadlineAt) => platform.fetchPerformance({ campaign: l.campaign, externalId: l.externalId }, d.date, { deadlineAt }));
      if (r.status !== 'success' || !isObj(r.value)) { unknown.push({ campaign: l.campaign, code: 'FETCH_FAILED' }); continue; }
      const cost = r.value.costKrw;
      if (cost === null) { unknown.push({ campaign: l.campaign, code: 'SPEND_UNKNOWN' }); continue; }
      if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) { unknown.push({ campaign: l.campaign, code: 'FETCH_FAILED' }); continue; }
      knownTotal += cost;
      if (d.date.startsWith(month) && cost > d.maxKrw) monthExtra += cost - d.maxKrw;
      if (cost > d.maxKrw) { code = 'DAY_OVER_MAX'; break; }
    }
    if (code) { await stop(l.campaign, l.externalId, code); continue; }
  }
  // 3) 월 예산(0034): 미설정이거나 이번 달 사용액(+ 보고 초과분)이 판정 한도 이상이면 열린 캠페인 전부 중지
  const monthCode: MonitorCode | null = targets.monthLimit <= 0 ? 'MONTHLY_BUDGET_UNSET' : targets.monthUsed + monthExtra >= targets.monthLimit ? 'MONTHLY_CAP_REACHED' : null;
  if (monthCode) {
    for (const l of targets.launches) if (l.state === 'active' && l.externalId && platform && !stopped.some((s) => s.campaign === l.campaign)) await stop(l.campaign, l.externalId, monthCode);
  }
  // 4) 계정 실제 보고 합계가 누적 상한에 닿으면 열린 캠페인 전부 중지
  if (knownTotal >= ACCOUNT_TOTAL_CAP_KRW) {
    for (const l of targets.launches) if (l.state === 'active' && !stopped.some((s) => s.campaign === l.campaign)) await stop(l.campaign, l.externalId, 'ACCOUNT_TOTAL_REACHED');
  }
  const ok = unknown.length === 0;
  let recorded = true;
  try {
    const detail = { run_id: deps.runId, today, checked: targets.launches.length, stopped: stopped.map((s) => `${s.campaign}:${s.code}:${s.paused ? 'paused' : 'not_paused'}`).slice(0, 20), unknown: unknown.map((u) => `${u.campaign}:${u.code}`).slice(0, 20) };
    await deps.runAsMonitor((tx) => tx`select api.ad_monitor_record(${ok}, ${JSON.stringify(detail)}::text::jsonb)`);
  } catch { recorded = false; }
  return { ok: ok && recorded, checked: targets.launches.length, stopped, unknown, recorded, busy: false };
}
