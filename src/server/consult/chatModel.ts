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

/** 사용료 예약: 호출 '전에' 비용을 올리고, 한도 초과·오류는 false(= 호출하지 않음). 비용 0원(모의)은 예약 없이 통과한다. */
export type AiBudget = { reserve(costKrw: number): Promise<boolean> };

/** 시험·로컬용 메모리 집계(프로세스 재시작 시 0). 운영 경로는 createDbAiBudget을 쓴다. */
export function createAiBudget(env: Record<string, string | undefined>): AiBudget {
  const raw = Number(env.CONSULT_AI_MONTHLY_BUDGET_KRW ?? '0');
  const limit = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  let used = 0;
  return {
    async reserve(cost) {
      if (!Number.isSafeInteger(cost) || cost < 0) return false;
      if (cost === 0) return true;
      if (used + cost > limit) return false;
      used += cost;
      return true;
    },
  };
}

/** DB 집계: api.ai_budget_reserve가 월 한도(core.ai_budget_config, 기본 0원)와 추가 전용 원장으로 판정한다. 어떤 오류든 false. */
export type RunAi = <T>(fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => Promise<T>) => Promise<T>;
export function createDbAiBudget(run: RunAi): AiBudget {
  return {
    async reserve(cost) {
      if (!Number.isSafeInteger(cost) || cost < 0) return false;
      if (cost === 0) return true;
      try {
        const rows = (await run(async (tx) => tx`select api.ai_budget_reserve(${cost}::int) as ok`)) as readonly { ok?: unknown }[];
        return rows[0]?.ok === true;
      } catch { return false; }
    },
  };
}
