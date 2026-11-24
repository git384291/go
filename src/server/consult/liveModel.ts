import 'server-only';
// 상담 라우트용 모델 선택(PM 11/24 ④ 실제 AI 모델 API 연동). 라우트는 이 함수만 쓴다.
// - CONSULT_AI_MODEL=openai: 실제 어댑터(OpenAI Responses API). 아래 3개가 모두 맞을 때만 전송한다(아니면 ModelNotCalledError → 0원 취소).
//     CONSULT_AI_API_KEY(서버 전용, 응답·로그 미노출) · CONSULT_AI_MODEL_NAME(공식 단가 확인 기록에 있는 모델만) · CONSULT_AI_EXECUTION_ALLOWED=true
//   1회 예약 비용은 확인된 단가 × 입력·출력 토큰 상한으로 계산(과소 예약 불가). 비용 한도·예약·확정은 기존 DB 경로(0028·0029) 그대로.
// - CONSULT_AI_MODEL=mock: 무료 모의 모델. **운영 배포(VERCEL_ENV=production)에서는 쓰지 않는다**(null → 안전 안내). 시험·로컬·미리보기 전용.
// - 그 밖·미설정: null(모델 없음 → 안전 안내).
// - 같은 설정이면 같은 모델 객체를 돌려준다(재시도·차단기 상태가 요청마다 초기화되지 않도록, recoveringModelFor 캐시).
import { createHash } from 'node:crypto';
import { estimateMaxKrw, priceFor } from '@/server/ai/costModel';
import { verifiedKrwPrices } from '@/server/ai/verifiedPrices';
import { OPENAI_RESPONSES_URL, openAiFetchTransport } from '@/server/ai/openAiTransport';
import { mockModel, type ChatModel } from './chatModel';
import { createOpenAiChatModel } from './openAiChatModel';

export const LIVE_LIMITS = Object.freeze({ maxInputTokens: 4000, maxOutputTokens: 512, timeoutMs: 7000, maxResponseBytes: 32768 });

let cached: { sig: string; model: ChatModel } | null = null;

export function createConsultModel(env: Readonly<Record<string, string | undefined>>): ChatModel | null {
  const kind = env.CONSULT_AI_MODEL;
  if (kind === 'mock') return env.VERCEL_ENV === 'production' ? null : mockModel;
  if (kind !== 'openai') return null;
  const apiKey = env.CONSULT_AI_API_KEY ?? null;
  const model = env.CONSULT_AI_MODEL_NAME ?? null;
  const executionAllowed = env.CONSULT_AI_EXECUTION_ALLOWED === 'true';
  // 설정 서명(키는 해시로만 비교, 원문을 따로 보관하지 않는다)
  const sig = createHash('sha256').update(`${apiKey ?? ''}|${model ?? ''}|${executionAllowed}`, 'utf8').digest('hex');
  if (cached?.sig === sig) return cached.model;
  const prices = verifiedKrwPrices();
  const p = model ? priceFor(prices, model) : null;
  const costPerCallKrw = (p && estimateMaxKrw(p, LIVE_LIMITS.maxInputTokens, LIVE_LIMITS.maxOutputTokens)) || 1; // 가격 모름 → 어댑터가 호출 거부
  const m = createOpenAiChatModel({ transport: openAiFetchTransport, endpoint: OPENAI_RESPONSES_URL, apiKey, model, executionAllowed, costPerCallKrw, prices, ...LIVE_LIMITS });
  cached = { sig, model: m };
  return m;
}
