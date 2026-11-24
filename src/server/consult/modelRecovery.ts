import 'server-only';
// 상담 AI 장애·타임아웃 자동 복구(PM 11/24 AI 상담 1번).
// - 재시도 가능한 오류(timeout·네트워크·429·5xx)만, 하드 상한(횟수 3·대기 2초·전체 7초) 안에서 다시 시도한다. 4xx(인증·형식)·거절·응답 형식 오류는 다시 시도하지 않는다.
// - 계속 실패하면 차단기(circuit breaker)가 열려 일정 시간 모델을 아예 부르지 않는다(ModelNotCalledError → 예약 취소 = 0원, 승인 안내문으로 즉시 전환).
//   닫힘 복구는 반열림 1회 시험 호출이 성공할 때만 한다.
// - 요청이 한 번이라도 나간 뒤에는 ModelNotCalledError를 내보내지 않는다(예약 비용을 취소하지 않고 확정 대상으로 남긴다).
// - 사용료: 재시도 포함 최대 비용을 예약(costPerCallKrw = 1회 비용 × 최대 시도 횟수, 1,000원 이하), 확정은 실제로 보낸 횟수만큼만 한다(meter).
// - 바깥 AbortSignal이 취소되면(상담 전체 시간 초과) 더 이상 시도하지 않는다. 오류 본문·헤더·키는 다루지 않는다.
// - 동시 요청(최종검증 R10): 다른 요청들의 실패로 차단기가 열리면, 대기 중인 요청도 다시 시도하지 않는다(장애 중 재시도 몰림 방지).
// - 장애 기록(R8): 차단기 열림·복구만 고정 형식으로 남긴다(고객 글·오류 원문·키 없음).
import { ModelNotCalledError, type CallMeter, type ChatModel, type ModelInput } from './chatModel';

export type ModelFailureKind = 'timeout' | 'network' | 'rate_limited' | 'server' | 'client' | 'response';
/** 모델 호출 실패의 종류만 담는다(원문·본문·키 없음) */
export class ModelCallError extends Error {
  readonly kind: ModelFailureKind;
  readonly status: number | undefined;
  /** 서버가 Retry-After(정수 초)로 알려 준 대기(ms). 없으면 undefined */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, kind: ModelFailureKind, status?: number, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
const RETRYABLE: ReadonlySet<ModelFailureKind> = new Set(['timeout', 'network', 'rate_limited', 'server']);
export const isRetryableModelError = (e: unknown): boolean => e instanceof ModelCallError && RETRYABLE.has(e.kind);
/** 차단기에 세는 실패: 고객 글 때문에 생기는 응답 형식·거절 오류는 세지 않는다 */
const countsForBreaker = (e: unknown): boolean => !(e instanceof ModelCallError && e.kind === 'response');

/** 어떤 설정을 넣어도 넘을 수 없는 하드 상한 */
export const RECOVERY_LIMITS = Object.freeze({ maxAttempts: 3, maxDelayMs: 2000, maxTotalMs: 7000, maxAttemptMs: 7000, maxBreakerFailures: 10, maxBreakerOpenMs: 120_000, maxCostKrw: 1000 });
/** 차단기 상태 변화 기록(고정 코드와 연속 실패 수만) */
export type RecoveryEvent = 'breaker_open' | 'breaker_recovered';
export type RecoveryLog = (event: RecoveryEvent, consecutiveFailures: number) => void;
const defaultRecoveryLog: RecoveryLog = (event, n) => { console.warn(`[ai-recovery] ${event} failures=${n}`); };
export type RecoveryConfig = {
  readonly maxAttempts?: number; readonly baseDelayMs?: number; readonly maxDelayMs?: number;
  readonly totalMs?: number; readonly attemptMs?: number;
  readonly breakerFailures?: number; readonly breakerOpenMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly log?: RecoveryLog;
};
const clampInt = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : d);
const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); resolve(); };
  signal.addEventListener('abort', onAbort, { once: true });
});

export function withRecovery(inner: ChatModel, config: RecoveryConfig = {}): ChatModel {
  const L = RECOVERY_LIMITS;
  const base = inner.costPerCallKrw;
  const wanted = clampInt(config.maxAttempts, 1, L.maxAttempts, 2);
  // 재시도 포함 예약 비용이 1,000원을 넘지 않게 시도 횟수를 줄인다(유료 모델에서만)
  const attempts = base > 0 ? Math.max(1, Math.min(wanted, Math.floor(L.maxCostKrw / base))) : wanted;
  const baseDelay = clampInt(config.baseDelayMs, 0, L.maxDelayMs, 400);
  const maxDelay = clampInt(config.maxDelayMs, 0, L.maxDelayMs, 1500);
  const totalMs = clampInt(config.totalMs, 1, L.maxTotalMs, 6500);
  const attemptMs = clampInt(config.attemptMs, 1, L.maxAttemptMs, 3500);
  const threshold = clampInt(config.breakerFailures, 1, L.maxBreakerFailures, 3);
  const openMs = clampInt(config.breakerOpenMs, 1, L.maxBreakerOpenMs, 30_000);
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? Date.now;
  const log = config.log ?? defaultRecoveryLog;
  const note = (e: RecoveryEvent, n: number) => { try { log(e, n); } catch { /* 기록 실패는 상담에 영향 없음 */ } };
  let failures = 0; // 연속 실패 요청 수
  let openUntil = 0; // 0 = 닫힘. 양수면 이 시각까지 호출 금지, 지난 뒤에는 반열림(시험 1회)
  let probing = false;

  async function attempt(input: ModelInput, parent: AbortSignal, ms: number, meter: CallMeter | undefined): Promise<string> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (parent.aborted) ac.abort(); else parent.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        inner.generate(input, ac.signal, meter), // 비용 게이트 허가를 그대로 넘긴다(개수는 이 래퍼가 센다)
        new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new ModelCallError('TIMEOUT', 'timeout')); }, ms); }),
        // 바깥 취소(상담 전체 시간 초과)도 기다리지 않고 바로 끝낸다
        new Promise<never>((_, rej) => { ac.signal.addEventListener('abort', () => rej(new ModelCallError('ABORTED', 'timeout')), { once: true }); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    }
  }

  return Object.freeze({
    name: inner.name,
    costPerCallKrw: base * attempts,
    attemptCostKrw: base,
    async generate(input: ModelInput, signal: AbortSignal, meter?: CallMeter): Promise<string> {
      const t0 = now();
      let probe = false;
      if (openUntil > 0) {
        if (t0 < openUntil) throw new ModelNotCalledError('CIRCUIT_OPEN'); // 호출 0회 → 예약 취소(0원)
        if (probing) throw new ModelNotCalledError('CIRCUIT_PROBING');
        probing = true; probe = true;
      }
      const deadline = t0 + totalMs;
      const max = probe ? 1 : attempts;
      let last: unknown = null;
      let sentAny = false;
      try {
        for (let n = 1; n <= max; n++) {
          const remaining = deadline - now();
          if (remaining <= 0 || signal.aborted) break;
          if (meter) meter.sent += 1;
          try {
            const out = await attempt(input, signal, Math.min(attemptMs, remaining), meter);
            if (openUntil > 0) note('breaker_recovered', failures);
            failures = 0; openUntil = 0;
            return out;
          } catch (e) {
            if (e instanceof ModelNotCalledError) {
              if (!sentAny) { if (meter) meter.sent -= 1; throw e; } // 첫 시도가 나가기 전 실패(설정 등): 재시도·차단기와 무관
              last = new ModelCallError('RETRY_NOT_SENT', 'network');
              break;
            }
            sentAny = true;
            last = e;
            if (!isRetryableModelError(e) || n >= max) break;
            // 서버가 우리 대기 상한보다 오래 기다리라고 하면 다시 시도하지 않는다(시간·비용 낭비 방지). 상한 안이면 그만큼 기다린다
            const ra = e instanceof ModelCallError ? e.retryAfterMs : undefined;
            if (ra !== undefined && ra > maxDelay) break;
            if (!probe && openUntil > now()) break; // 그사이 다른 요청들의 실패로 차단기가 열렸다 → 다시 시도하지 않는다
            const delay = Math.min(maxDelay, Math.max(baseDelay * 2 ** (n - 1), ra ?? 0));
            if (deadline - now() <= delay) break; // 다시 시도할 시간이 없다
            await sleep(delay, signal);
            if (signal.aborted || (!probe && openUntil > now())) break;
          }
        }
        if (sentAny && countsForBreaker(last)) {
          failures += 1;
          if (probe || failures >= threshold) {
            if (probe || openUntil === 0) note('breaker_open', failures);
            openUntil = now() + openMs;
          }
        }
        throw last instanceof Error ? last : new ModelCallError('MODEL_FAILED', 'network');
      } finally {
        if (probe) probing = false;
      }
    },
  });
}

// 안정적인 모델 객체 1개당 복구 상태(차단기) 1개: 요청마다 새로 만들면 차단기가 의미 없다.
const cache = new WeakMap<ChatModel, ChatModel>();
export function recoveringModelFor(model: ChatModel | null): ChatModel | null {
  if (!model) return null;
  let w = cache.get(model);
  if (!w) { w = withRecovery(model); cache.set(model, w); }
  return w;
}
