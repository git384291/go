import 'server-only';
import { callPlatform, type AdPlatform } from '../advertising/platform';

/**
 * 광고 활성화 예약 실행(PM 11/25 ②③). 외부 스케줄러(HTTP 호출)가 /api/internal/ad-scheduler를 부른다 — 특정 호스팅(Vercel Cron 등)에 묶이지 않는다.
 * 한 번 호출 = 실행 시각이 지난 예약 최대 1건. 직원 세션 없이 전용 DB 역할(app_ad_scheduler)만 쓴다.
 * 순서(어느 단계든 막히면 ENABLED 요청 없음):
 *  0) 플랫폼 없음·실제(live) 플랫폼·활성화 기능 없음 → 잡지 않거나(플랫폼 없음) 잡은 예약을 failed로 닫는다. 실제 Google Ads ENABLED는 부르지 않는다.
 *  1) DB가 예약 1건을 잡는다(여러 서버 동시 호출 → 1건만, 실행 시각 전에는 없음).
 *  2) 매체 상태 확인: PAUSED가 아니면 활성화하지 않는다(이미 ENABLED·형식 이상·조회 실패 = 불명 → 중지·경고).
 *  3) DB 최종 판정(계정 잠금 안): 대표 승인·키워드·CPC·기간·월/일/계정 예산·정기 감시·경고.
 *  4) 활성화(모의) → 5) 다시 읽어 ENABLED일 때만 enabled. 불일치·시간 초과·오류는 중지(pause + 승인 철회) 후 unknown(경고, 사람 확인).
 * 중지 실패는 성공으로 표시하지 않는다(ok=false, STOP_FAILED). 키·토큰·외부 ID는 결과에 넣지 않는다.
 */
export type SchedulerTx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
export type SchedulerDeps = {
  readonly platform: AdPlatform | null;
  readonly runAsScheduler: <T>(fn: (tx: SchedulerTx) => Promise<T>) => Promise<T>;
  /** 회차 ID(UUID). 잡은 예약은 이 회차만 판정·기록할 수 있다 */
  readonly runId: string;
};
export type SchedulerCode =
  | 'IDLE' | 'ENABLED' | 'PLATFORM_UNAVAILABLE' | 'LIVE_ENABLE_FORBIDDEN' | 'ENABLE_UNSUPPORTED' | 'CLAIM_FAILED' | 'BAD_JOB'
  | 'PRECHECK_FAILED' | 'NOT_PAUSED' | 'GATE_FAILED' | 'BLOCKED' | 'ENABLE_FAILED' | 'ENABLE_UNKNOWN' | 'POSTCHECK_MISMATCH' | 'FINISH_FAILED' | 'STOP_FAILED';
export type SchedulerResult = {
  readonly ok: boolean;
  readonly code: SchedulerCode;
  readonly campaign: string | null;
  /** DB 최종 판정이 막은 사유(BLOCKED일 때) */
  readonly reason: string | null;
  readonly enableCalls: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAMPAIGN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REASON = /^[A-Z_]{2,40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const statusOf = (v: unknown): string | null => (isObj(v) && typeof v.status === 'string' ? v.status : null);

export async function runAdScheduler(deps: SchedulerDeps): Promise<SchedulerResult> {
  let enableCalls = 0;
  const res = (ok: boolean, code: SchedulerCode, campaign: string | null = null, reason: string | null = null): SchedulerResult => ({ ok, code, campaign, reason, enableCalls });
  const platform = deps.platform;
  // 플랫폼이 없으면 예약을 잡지도 않는다(예약은 그대로 남고 다음 회차에 다시 본다)
  if (!platform) return res(false, 'PLATFORM_UNAVAILABLE');
  if (!UUID.test(deps.runId)) return res(false, 'CLAIM_FAILED');

  let job: { id: string; campaign: string; externalId: string | null } | null = null;
  try {
    const rows = await deps.runAsScheduler((tx) => tx`select api.ad_sched_claim(${deps.runId}::uuid) as r`);
    const r = (rows as readonly { r?: unknown }[])[0]?.r;
    if (!isObj(r) || !('job' in r)) return res(false, 'CLAIM_FAILED');
    if (r.job === null) return res(true, 'IDLE');
    const j = r.job;
    if (!isObj(j) || typeof j.id !== 'string' || !UUID.test(j.id) || typeof j.campaign !== 'string' || !CAMPAIGN.test(j.campaign)) return res(false, 'BAD_JOB');
    job = { id: j.id, campaign: j.campaign, externalId: typeof j.external_id === 'string' && j.external_id.length >= 1 && j.external_id.length <= 100 ? j.external_id : null };
  } catch {
    return res(false, 'CLAIM_FAILED');
  }
  const { id, campaign } = job;
  const finish = async (state: 'enabled' | 'failed' | 'unknown', code: string): Promise<boolean> => {
    try { await deps.runAsScheduler((tx) => tx`select api.ad_sched_finish(${id}::uuid, ${deps.runId}::uuid, ${state}, ${code})`); return true; } catch { return false; }
  };
  // 중지: 매체 pause → DB 승인 철회(pause 실패면 경고 = 계정 전체 새 지출 차단). 성공은 pause와 기록이 모두 됐을 때만
  const stop = async (code: string): Promise<boolean> => {
    let paused = false;
    if (job!.externalId) {
      const p = await callPlatform((deadlineAt) => platform.pause({ campaign, externalId: job!.externalId }, { deadlineAt }));
      paused = p.status === 'success' && isObj(p.value) && p.value.paused === true;
    }
    let recorded = true;
    try { await deps.runAsScheduler((tx) => tx`select api.ad_monitor_stop(${campaign}, ${code}, ${paused}) as r`); } catch { recorded = false; }
    return paused && recorded;
  };

  // 0) 실제 플랫폼 ENABLED 금지(PM 11/25) · 활성화 기능 없는 어댑터 · 외부 ID 없음 → 활성화하지 않고 failed로 닫는다(집행 변화 없음)
  if (platform.live) { const f = await finish('failed', 'LIVE_ENABLE_FORBIDDEN'); return res(false, f ? 'LIVE_ENABLE_FORBIDDEN' : 'FINISH_FAILED', campaign); }
  if (typeof platform.enable !== 'function' || typeof platform.campaignStatus !== 'function') { const f = await finish('failed', 'ENABLE_UNSUPPORTED'); return res(false, f ? 'ENABLE_UNSUPPORTED' : 'FINISH_FAILED', campaign); }
  if (!job.externalId) { const f = await finish('failed', 'NO_EXTERNAL_ID'); return res(false, f ? 'BAD_JOB' : 'FINISH_FAILED', campaign); }
  const ref = { campaign, externalId: job.externalId };
  const readStatus = platform.campaignStatus.bind(platform);
  const doEnable = platform.enable.bind(platform);

  // 2) 활성화 전 상태: PAUSED만 진행. 조회 실패는 failed(아무것도 바꾸지 않음). 이미 ENABLED·알 수 없는 상태는 불명 → 중지·경고
  const pre = await callPlatform((deadlineAt) => readStatus(ref, { deadlineAt }));
  if (pre.status !== 'success') { const f = await finish('failed', 'PRECHECK_FAILED'); return res(false, f ? 'PRECHECK_FAILED' : 'FINISH_FAILED', campaign); }
  if (statusOf(pre.value) !== 'PAUSED') {
    const stopped = await stop('ENABLE_PRECHECK_MISMATCH');
    await finish('unknown', 'NOT_PAUSED');
    return res(false, stopped ? 'NOT_PAUSED' : 'STOP_FAILED', campaign);
  }

  // 3) DB 최종 판정. 막히면 DB가 예약을 blocked로 닫는다. 판정 오류는 failed(활성화 없음)
  try {
    const rows = await deps.runAsScheduler((tx) => tx`select api.ad_sched_gate(${id}::uuid, ${deps.runId}::uuid) as r`);
    const r = (rows as readonly { r?: unknown }[])[0]?.r;
    if (!isObj(r) || (r.decision !== 'ALLOW' && r.decision !== 'BLOCK')) { const f = await finish('failed', 'GATE_ERROR'); return res(false, f ? 'GATE_FAILED' : 'FINISH_FAILED', campaign); }
    if (r.decision === 'BLOCK') return res(true, 'BLOCKED', campaign, typeof r.reason === 'string' && REASON.test(r.reason) ? r.reason : 'UNKNOWN');
  } catch {
    const f = await finish('failed', 'GATE_ERROR');
    return res(false, f ? 'GATE_FAILED' : 'FINISH_FAILED', campaign);
  }

  // 4) 활성화(모의만). failed = 바뀌지 않음이 확실 → 상태를 다시 읽어 PAUSED면 failed, 아니면 불명. unknown(시간 초과 등) = 중지·경고
  enableCalls++;
  const en = await callPlatform((deadlineAt) => doEnable(ref, { deadlineAt }));
  if (en.status !== 'success') {
    const stopped = await stop(en.status === 'failed' ? 'ENABLE_FAILED' : 'ENABLE_UNKNOWN');
    await finish(en.status === 'failed' ? 'failed' : 'unknown', en.status === 'failed' ? 'ENABLE_FAILED' : 'ENABLE_UNKNOWN');
    return res(false, stopped ? (en.status === 'failed' ? 'ENABLE_FAILED' : 'ENABLE_UNKNOWN') : 'STOP_FAILED', campaign);
  }
  // 5) 다시 읽어 ENABLED일 때만 성공. 불일치·조회 실패 = 중지·경고
  const post = await callPlatform((deadlineAt) => readStatus(ref, { deadlineAt }));
  if (post.status !== 'success' || statusOf(post.value) !== 'ENABLED') {
    const stopped = await stop('ENABLE_POSTCHECK');
    await finish('unknown', 'POSTCHECK_MISMATCH');
    return res(false, stopped ? 'POSTCHECK_MISMATCH' : 'STOP_FAILED', campaign);
  }
  if (!(await finish('enabled', 'ENABLED'))) {
    // 매체는 ENABLED인데 기록 실패: 성공으로 두지 않고 중지
    const stopped = await stop('ENABLE_UNRECORDED');
    return res(false, stopped ? 'FINISH_FAILED' : 'STOP_FAILED', campaign);
  }
  return res(true, 'ENABLED', campaign);
}
