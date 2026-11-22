import 'server-only';
import { callPlatform, type AdPlatform } from '../advertising/platform';

/**
 * 광고 정기 감시(PM 11/22 P0). 예약 실행(외부 스케줄러 → /api/internal/ad-monitor)이 부른다. 직원 세션 없이 전용 DB 역할(app_ad_monitor)만 쓴다.
 * - 열린 launch마다: 승인 없음·만료, 집행 종료일 경과면 중지. 날짜별 실제 비용(보고값)이 그날 최대 청구액을 넘거나 계정 합계가 3만원 이상이면 중지.
 * - 보고 지연(비용 null)·조회 실패·불명 launch는 UNKNOWN: 실행 기록을 '정상 아님'으로 남겨 새 집행을 막는다(DB: MONITOR_NOT_OK).
 * - 중지는 매체 pause → DB 승인 철회. pause가 실패하면 중지 실패 경고(계정 전체 STOP_PENDING). 실행 자체가 실패하면 기록이 끊겨 2시간 뒤 MONITOR_STALE.
 * - 키·토큰·외부 ID·고객 정보는 결과·기록에 넣지 않는다(캠페인 키와 고정 코드만).
 */
export type MonitorTx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
export type MonitorDeps = {
  readonly platform: AdPlatform | null;
  readonly now: () => Date;
  readonly runAsMonitor: <T>(fn: (tx: MonitorTx) => Promise<T>) => Promise<T>;
};
export type MonitorCode =
  | 'NO_ACTIVE_APPROVAL' | 'APPROVAL_EXPIRED' | 'WINDOW_ENDED' | 'NO_WINDOW' | 'DAY_OVER_MAX' | 'ACCOUNT_TOTAL_REACHED'
  | 'SPEND_UNKNOWN' | 'FETCH_FAILED' | 'LAUNCH_UNKNOWN' | 'PLATFORM_UNAVAILABLE' | 'STOP_FAILED' | 'STOP_RECORD_FAILED' | 'TARGETS_UNAVAILABLE' | 'RECORD_FAILED';
export type MonitorResult = {
  readonly ok: boolean;
  readonly checked: number;
  readonly stopped: readonly { readonly campaign: string; readonly code: MonitorCode; readonly paused: boolean }[];
  readonly unknown: readonly { readonly campaign: string; readonly code: MonitorCode }[];
  readonly recorded: boolean;
};

const ACCOUNT_TOTAL_CAP_KRW = 30_000;
const CAMPAIGN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

type Launch = { campaign: string; state: string; externalId: string | null; validUntil: number | null; endDate: string | null; days: { date: string; maxKrw: number }[] };

function parseTargets(v: unknown): { launches: Launch[]; accountTotal: number } | null {
  if (!isObj(v) || !Array.isArray(v.launches) || typeof v.account_total_krw !== 'number') return null;
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
  return { launches, accountTotal: v.account_total_krw };
}

export async function runAdMonitor(deps: MonitorDeps): Promise<MonitorResult> {
  const now = deps.now();
  const today = kstDay(now);
  const stopped: { campaign: string; code: MonitorCode; paused: boolean }[] = [];
  const unknown: { campaign: string; code: MonitorCode }[] = [];
  let targets: ReturnType<typeof parseTargets> = null;
  try {
    const rows = await deps.runAsMonitor((tx) => tx`select api.ad_monitor_targets() as r`);
    targets = parseTargets((rows as readonly { r?: unknown }[])[0]?.r);
  } catch { targets = null; }
  if (!targets) {
    // 대상 조회 실패: 기록도 시도하지 않는다(보통 같은 원인) → 기록이 끊겨 2시간 뒤 새 집행 차단
    return { ok: false, checked: 0, stopped, unknown: [{ campaign: '-', code: 'TARGETS_UNAVAILABLE' }], recorded: false };
  }
  const platform = deps.platform;
  let knownTotal = 0;

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
    let code: MonitorCode | null = null;
    if (l.days.length === 0 || !l.endDate) code = 'NO_WINDOW';
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
      if (cost > d.maxKrw) { code = 'DAY_OVER_MAX'; break; }
    }
    if (code) { await stop(l.campaign, l.externalId, code); continue; }
  }
  // 3) 계정 실제 보고 합계가 누적 상한에 닿으면 열린 캠페인 전부 중지
  if (knownTotal >= ACCOUNT_TOTAL_CAP_KRW) {
    for (const l of targets.launches) if (l.state === 'active' && !stopped.some((s) => s.campaign === l.campaign)) await stop(l.campaign, l.externalId, 'ACCOUNT_TOTAL_REACHED');
  }
  const ok = unknown.length === 0;
  let recorded = true;
  try {
    const detail = { today, checked: targets.launches.length, stopped: stopped.map((s) => `${s.campaign}:${s.code}:${s.paused ? 'paused' : 'not_paused'}`).slice(0, 20), unknown: unknown.map((u) => `${u.campaign}:${u.code}`).slice(0, 20) };
    await deps.runAsMonitor((tx) => tx`select api.ad_monitor_record(${ok}, ${JSON.stringify(detail)}::text::jsonb)`);
  } catch { recorded = false; }
  return { ok: ok && recorded, checked: targets.launches.length, stopped, unknown, recorded };
}
