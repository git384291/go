/**
 * 상담 AI 모델 인터페이스(PM 11/21 3·4·5항). 모델은 교체 가능한 어댑터이고, 이 파일에는 무료 모의 모델만 있다.
 * - 실제 API 호출 어댑터는 만들지 않았다(별도 승인 전 금지). CONSULT_AI_MODEL이 'mock'이 아니면 모델 없음 → 안전 안내문.
 * - API 키(CONSULT_AI_API_KEY)는 서버 환경변수에서만 읽는 자리다. 응답·화면·로그로 내보내지 않으며, 모의 모델은 읽지도 않는다.
 * - 사용료 한도(CONSULT_AI_MONTHLY_BUDGET_KRW)의 기본값은 0원. 호출당 비용이 0원인 모의 모델만 한도 0에서 돈다.
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

export type AiBudget = { allow(costKrw: number): boolean; record(costKrw: number): void };
/** 월 한도(원). 한도 0 이하·형식 오류는 0원으로 본다. 사용액은 프로세스 메모리(재시작 시 0 — 영속 집계는 실제 호출 승인 때 DB로 옮긴다) */
export function createAiBudget(env: Record<string, string | undefined>): AiBudget {
  const raw = Number(env.CONSULT_AI_MONTHLY_BUDGET_KRW ?? '0');
  const limit = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  let used = 0;
  return {
    allow: (cost) => Number.isSafeInteger(cost) && cost >= 0 && (cost === 0 || used + cost <= limit),
    record: (cost) => { used += cost; },
  };
}
