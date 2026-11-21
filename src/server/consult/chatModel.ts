/**
 * 상담 AI 모델 인터페이스(PM 11/21 3·4·5항). 모델은 교체 가능한 어댑터이고, 이 파일에는 무료 모의 모델만 있다.
 * - 실제 API 호출 어댑터는 만들지 않았다(별도 승인 전 금지). CONSULT_AI_MODEL이 'mock'이 아니면 모델 없음 → 안전 안내문.
 * - API 키(CONSULT_AI_API_KEY)는 서버 환경변수에서만 읽는 자리다. 응답·화면·로그로 내보내지 않으며, 모의 모델은 읽지도 않는다.
 * - 사용료는 DB에 집계한다(core.ai_budget_config 월 한도 기본 0원 + 추가 전용 원장, 호출 '전에' 예약). 비용 0원인 모의 모델만 한도 0에서 돈다. CONSULT_AI_MONTHLY_BUDGET_KRW는 시험용 메모리 집계 전용.
 */
export type ModelInput = { readonly system: string; readonly user: string; readonly approved: string };
export type ChatModel = {
  readonly name: string;
  readonly costPerCallKrw: number;
  generate(input: ModelInput, signal: AbortSignal): Promise<string>;
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
export type Reservation = { confirm(actualKrw: number): Promise<void>; cancel(): Promise<void> };
export type AiBudget = { reserve(costKrw: number): Promise<Reservation | null> };
const NOOP: Reservation = Object.freeze({ async confirm() {}, async cancel() {} });

/** 시험·로컬용 메모리 집계(프로세스 재시작 시 0). 운영 경로는 createDbAiBudget을 쓴다. */
export function createAiBudget(env: Record<string, string | undefined>): AiBudget {
  const raw = Number(env.CONSULT_AI_MONTHLY_BUDGET_KRW ?? '0');
  const limit = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  let used = 0;
  return {
    async reserve(cost) {
      if (!Number.isSafeInteger(cost) || cost < 0) return null;
      if (cost === 0) return NOOP;
      if (used + cost > limit) return null;
      used += cost;
      let done = false;
      const settle = (actual: number) => { if (!done) { done = true; used += actual - cost; } };
      return { async confirm(a) { settle(Math.max(0, Math.min(1000, Math.trunc(a)))); }, async cancel() { settle(0); } };
    },
  };
}

/** DB 집계: api.ai_budget_hold/confirm/release가 월 한도(core.ai_budget_config, 기본 0원)와 추가 전용 원장으로 판정한다. 어떤 오류든 예약 거부, 정산 오류는 삼킨다(미정산 = 예약 비용 전액). */
export type RunAi = <T>(fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => Promise<T>) => Promise<T>;
export function createDbAiBudget(run: RunAi): AiBudget {
  return {
    async reserve(cost) {
      if (!Number.isSafeInteger(cost) || cost < 0) return null;
      if (cost === 0) return NOOP;
      let id: unknown;
      try {
        const rows = (await run(async (tx) => tx`select api.ai_budget_hold(${cost}::int)::text as id`)) as readonly { id?: unknown }[];
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
        confirm: (actual) => settle((tx) => tx`select api.ai_budget_confirm(${id as string}::bigint, ${Math.max(0, Math.min(1000, Math.trunc(actual)))}::int)`),
        cancel: () => settle((tx) => tx`select api.ai_budget_release(${id as string}::bigint)`),
      };
    },
  };
}
