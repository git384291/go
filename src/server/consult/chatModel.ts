/**
 * 상담 AI 모델 인터페이스(PM 11/21 3·4·5항). 모델은 교체 가능한 어댑터이고, 이 파일에는 무료 모의 모델만 있다.
 * - 실제 API 호출 어댑터는 만들지 않았다(별도 승인 전 금지). CONSULT_AI_MODEL이 'mock'이 아니면 모델 없음 → 안전 안내문.
 * - API 키(CONSULT_AI_API_KEY)는 서버 환경변수에서만 읽는 자리다. 응답·화면·로그로 내보내지 않으며, 모의 모델은 읽지도 않는다.
 * - 사용료는 DB에 집계한다(core.ai_budget_config 월 한도 기본 0원 + 추가 전용 원장, 호출 '전에' 예약). 비용 0원인 모의 모델만 한도 0에서 돈다. CONSULT_AI_MONTHLY_BUDGET_KRW는 시험용 메모리 집계 전용.
 */
export type ModelInput = { readonly system: string; readonly user: string; readonly approved: string };
/** 재시도 포함 호출에서 실제로 보낸 횟수(복구 래퍼가 올린다). 모델이 세지 않으면 0이고, 그때는 예약 비용 전액을 확정한다 */
export type CallMeter = { sent: number };
export type ChatModel = {
  readonly name: string;
  /** 1회 상담 답변에 예약하는 최대 비용(재시도 포함) */
  readonly costPerCallKrw: number;
  /** 1회 전송당 비용(재시도 복구 래퍼만 채운다). 확정 비용 = attemptCostKrw × 실제 전송 횟수(예약 이하) */
  readonly attemptCostKrw?: number;
  generate(input: ModelInput, signal: AbortSignal, meter?: CallMeter): Promise<string>;
};

export const SYSTEM_PROMPT = '승인된 안내문 안의 금액·사은품 외에는 어떤 금액·혜택도 말하지 않는다. 모르면 담당자 확인으로 안내한다.';

export const mockModel: ChatModel = Object.freeze({
  name: 'mock',
  costPerCallKrw: 0,
  async generate({ approved }) {
    return `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${approved}`;
  },
});

export function createModel(env: Record<string, string | undefined>): ChatModel | null {
  return env.CONSULT_AI_MODEL === 'mock' ? mockModel : null;
}

/** 모델 어댑터가 '요청을 보내기 전에' 실패했을 때 던진다(설정 누락 등). 이때만 예약을 취소(0원)하고, 그 밖의 실패는 예약 비용을 확정한다(보수적). */
export class ModelNotCalledError extends Error {}

/** 사용료 예약 → 호출 → 확정(실제 비용)/취소(호출 안 함). 정산이 오지 않은 예약은 DB가 예약 비용 전액으로 센다. */
// - uncertain(): 요청이 나갔지만 과금 여부를 알 수 없음(시간 초과·연결 끊김) → 예약 전액으로 닫고 대표 조정 대기(0028). 없으면 확정으로 처리한다.
export type Reservation = { confirm(actualKrw: number): Promise<void>; cancel(): Promise<void>; uncertain?(): Promise<void> };
/** 예약 문맥(0028): 요청 ID(멱등, 같은 ID는 다시 예약하지 않음)와 사용자 키(서버 HMAC 64자리, 사용자별 일·월 한도) */
export type ReserveContext = { readonly requestId: string; readonly scope: string };
export const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/;
export const SCOPE_KEY = /^[0-9a-f]{64}$/;
export type AiBudget = { reserve(costKrw: number, ctx?: ReserveContext): Promise<Reservation | null> };
const NOOP: Reservation = Object.freeze({ async confirm() {}, async cancel() {}, async uncertain() {} });

/**
 * 공통 비용 게이트 허가(P0 TEST-14). 유료 어댑터는 이 허가가 붙은 meter 없이는 전송하지 않는다(ModelNotCalledError).
 * 허가는 예약이 성공한 직후에만 붙고, 답변이 끝나면 떼어 낸다 — 어댑터를 직접 부르면(예약 없이) 전송 0회.
 * 허가를 붙이는 곳은 정적 시험이 목록으로 고정한다(chatAnswer·광고 생성 게이트).
 */
const permits = new WeakSet<CallMeter>();
export function grantBudgetPermit(m: CallMeter): void { permits.add(m); }
export function revokeBudgetPermit(m: CallMeter): void { permits.delete(m); }
export function hasBudgetPermit(m: unknown): boolean { return typeof m === 'object' && m !== null && permits.has(m as CallMeter); }

/** 원 단위 한도 문자열: 10진 정수(0~1,000,000)만. 0x10·1e3·공백·부호·소수는 무효(null) — 추측해 해석하지 않는다 */
export function parseKrwLimit(v: string | undefined): number | null {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,6})$/.test(v)) return null;
  const n = Number(v);
  return n <= 1_000_000 ? n : null;
}
/** 설정 오류 기록(관리자 확인용). 값·키는 남기지 않고 변수 이름과 고정 코드만 */
export type ConfigLog = (code: string, name: string) => void;
const defaultConfigLog: ConfigLog = (code, name) => { console.error(`[ai-cost] ${code} ${name}`); };

/** 시험·로컬용 메모리 집계(프로세스 재시작 시 0). 운영 경로는 createDbAiBudget을 쓴다. */
export function createAiBudget(env: Record<string, string | undefined>, log: ConfigLog = defaultConfigLog): AiBudget {
  const rawEnv = env.CONSULT_AI_MONTHLY_BUDGET_KRW;
  const parsed = rawEnv === undefined ? 0 : parseKrwLimit(rawEnv);
  if (parsed === null) log('CONFIG_INVALID', 'CONSULT_AI_MONTHLY_BUDGET_KRW'); // 무효 = 0원(호출 금지), 관리자 확인용 기록
  const limit = parsed ?? 0;
  let used = 0;
  const seen = new Set<string>();
  return {
    async reserve(cost, ctx) {
      if (!Number.isSafeInteger(cost) || cost < 0) return null;
      if (cost === 0) return NOOP;
      if (ctx && (!REQUEST_ID.test(ctx.requestId) || seen.has(ctx.requestId))) return null; // 같은 요청 ID 재예약 금지
      if (used + cost > limit) return null;
      if (ctx) seen.add(ctx.requestId);
      used += cost;
      let done = false;
      const settle = (actual: number) => { if (!done) { done = true; used += actual - cost; } };
      // 확정은 1원 이상(호출이 나간 뒤 0원으로 지우지 못함, DB 0028와 같음). 0원은 취소(호출 안 함)뿐
      return { async confirm(a) { settle(Math.max(1, Math.min(1000, Math.trunc(Number.isFinite(a) ? a : cost)))); }, async cancel() { settle(0); }, async uncertain() { settle(cost); } };
    },
  };
}

/** DB 집계: api.ai_budget_hold/confirm/release가 월 한도(core.ai_budget_config, 기본 0원)와 추가 전용 원장으로 판정한다. 어떤 오류든 예약 거부, 정산 오류는 삼킨다(미정산 = 예약 비용 전액). */
export type RunAi = <T>(fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => Promise<T>) => Promise<T>;
export function createDbAiBudget(run: RunAi): AiBudget {
  return {
    async reserve(cost, ctx) {
      if (!Number.isSafeInteger(cost) || cost < 0) return null;
      if (cost === 0) return NOOP;
      // 0028: 요청 ID·사용자 키가 없거나 형식이 틀리면 DB가 거부한다(null). 여기서 지어내지 않는다
      const req = ctx && REQUEST_ID.test(ctx.requestId) ? ctx.requestId : null;
      const scope = ctx && SCOPE_KEY.test(ctx.scope) ? ctx.scope : null;
      let id: unknown;
      try {
        const rows = (await run(async (tx) => tx`select api.ai_budget_hold(${cost}::int, ${req}::text, ${scope}::text)::text as id`)) as readonly { id?: unknown }[];
        id = rows[0]?.id;
      } catch { return null; }
      if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) return null;
      // 정산은 예약당 1번만 DB에 반영되는 멱등 호출이라 일시 장애는 최대 3번까지 다시 시도한다(false = 이미 정산됨 → 끝).
      // 끝내 안 되면 미정산으로 남고, DB는 예약 비용 전액으로 센다(비용을 줄여 세지 않는다).
      const settle = async (q: (tx: Parameters<Parameters<RunAi>[0]>[0]) => PromiseLike<unknown>) => {
        for (let i = 0; i < 3; i++) {
          try { await run(async (tx) => q(tx)); return; } catch { /* 다시 시도 */ }
        }
      };
      return {
        confirm: (actual) => settle((tx) => tx`select api.ai_budget_confirm(${id as string}::bigint, ${Math.max(1, Math.min(1000, Math.trunc(Number.isFinite(actual) ? actual : cost)))}::int)`),
        cancel: () => settle((tx) => tx`select api.ai_budget_release(${id as string}::bigint)`),
        uncertain: () => settle((tx) => tx`select api.ai_budget_uncertain(${id as string}::bigint)`),
      };
    },
  };
}
