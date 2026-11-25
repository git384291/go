import 'server-only';
// 상담 AI 실제 모델 어댑터(PM 11/22 4c7f269 지시 9). PM 11/24: 공식 확인 가격표(verifiedPrices)를 상담 경로에 연결(consultModelFromEnv).
// - PM 11/24 ④: 라우트는 server/ai/openAiTransport(허용 주소 1곳)를 넘긴다. 실제 전송은 CONSULT_AI_EXECUTION=allow + 키 + 주소가 모두 있을 때만.
// - 성공 응답의 usage(입력·캐시·출력 토큰) → 실제 비용(settleKrw) → meter. chatAnswer가 그 값으로 확정(confirm)한다.
// - 가격표에 없는(단가 불확실) 모델 이름은 모델 없음(null) → 안전 안내문, 호출 0회.
// - 요청·응답 형식은 광고 소재 생성 어댑터와 같은 Responses API 형식(store:false, tools 없음)을 가정한다.
//   **실제 업체·주소·모델명·가격은 정하지 않았다**: 주소(endpoint)도 주입이며 코드에 실제 서비스 주소를 두지 않는다(정적 시험 RD2·CH10).
//   연결 승인 시 공식 문서로 형식을 다시 확인한다(Claude 환경에서 이번에 원문 미열람).
// - transport·키·모델·실행 허용은 모두 명시 주입(환경변수·기본 클라이언트 없음). 설정이 없거나 허용이 아니면 ModelNotCalledError(전송 0회 → 예약 취소).
// - 입력은 chatAnswer의 전송 경계(piiBoundary)를 통과한 고객 글(개인정보 신호 없음)과 서버가 만든 승인 안내문뿐이다. 이 어댑터는 다른 고객 정보를 받지 않는다.
// - 출력은 그대로 믿지 않는다: chatAnswer가 금액·혜택 가드(guardAiReply·benefitClaimsAllowed)로 다시 검사하고, 실패하면 승인 안내문으로 대체한다.
// - 1요청 1호출(재시도는 이 어댑터 밖의 modelRecovery.withRecovery가 하드 상한 안에서만), 응답 크기 상한, 마감 시각 초과 시 중단. 오류 본문·헤더·키는 반사하지 않는다.
import { boundedRequest, parseJsonSafe, type BodyTransport } from '@/server/advertising/boundedHttp';
import { hasBudgetPermit, ModelNotCalledError, type CallMeter, type ChatModel, type ModelInput } from './chatModel';
import { estimateMaxKrw, inputTokenUpperBound, priceFor, settleKrw, type ModelPrice } from '@/server/ai/costModel';
import { verifiedKrwPrices } from '@/server/ai/verifiedPrices';
import { createModel } from './chatModel';
import { ModelCallError } from './modelRecovery';
import { isSafeModelInput } from './piiBoundary';

export const MAX_REPLY_CHARS = 600;

export type OpenAiChatModelConfig = {
  readonly transport: BodyTransport | null;
  /** 요청 주소(https, 승인 시 주입). 사용자 정보·쿼리·조각 불가 */
  readonly endpoint: string | null;
  readonly apiKey: string | null;
  readonly model: string | null;
  /** 정확히 true일 때만 전송한다 */
  readonly executionAllowed: unknown;
  /** 1회 호출 예약 비용(원). DB 월 한도(기본 0원) 예약에 쓴다. 1 이상 정수 */
  readonly costPerCallKrw: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** 0028·TEST-10: 승인된 가격표(주입, 코드에 실제 가격 없음). 모델이 없거나 KRW가 아니면 호출 금지 */
  readonly prices: readonly ModelPrice[] | null;
  /** 요청당 입력 토큰 상한(가정: 토큰 ≤ UTF-8 바이트). 넘으면 전송 0회 */
  readonly maxInputTokens: number;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ENDPOINT = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\/[A-Za-z0-9/._-]{1,100}$/;
const valid = (c: OpenAiChatModelConfig | null): c is OpenAiChatModelConfig & { transport: BodyTransport; endpoint: string; apiKey: string; model: string } =>
  !!c && c.executionAllowed === true && typeof c.transport === 'function' &&
  typeof c.endpoint === 'string' && ENDPOINT.test(c.endpoint) &&
  typeof c.apiKey === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(c.apiKey) &&
  typeof c.model === 'string' && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(c.model) &&
  Number.isSafeInteger(c.costPerCallKrw) && c.costPerCallKrw >= 1 && c.costPerCallKrw <= 1000 &&
  Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16 && c.maxOutputTokens <= 512 &&
  Number.isSafeInteger(c.timeoutMs) && c.timeoutMs >= 1000 && c.timeoutMs <= 15000 &&
  Number.isSafeInteger(c.maxResponseBytes) && c.maxResponseBytes >= 1024 && c.maxResponseBytes <= 65536 &&
  Number.isSafeInteger(c.maxInputTokens) && c.maxInputTokens >= 64 && c.maxInputTokens <= 20000 &&
  coversMaxCost(c);
/** 예약 비용(1회)이 가격표로 계산한 예상 최대 비용 이상이어야 한다(과소 예약 = 호출 금지) */
function coversMaxCost(c: OpenAiChatModelConfig): boolean {
  const p = typeof c.model === 'string' ? priceFor(c.prices, c.model) : null;
  if (!p) return false;
  const max = estimateMaxKrw(p, c.maxInputTokens, c.maxOutputTokens);
  return max !== null && max <= c.costPerCallKrw;
}

/** 요청 본문(고정 구조). 고객 글은 가린 뒤의 글만, 승인 안내문은 서버 문장만 */
export function buildChatBody(model: string, input: ModelInput, maxOutputTokens: number): string {
  return JSON.stringify({
    model,
    instructions: input.system,
    input: `[승인 안내문]\n${input.approved}\n\n[고객 문의(개인정보 가림)]\n${input.user}`,
    store: false,
    max_output_tokens: maxOutputTokens,
  });
}

/** 응답(불신)에서 output_text 1개만 꺼낸다. 거절·미완료·형식 이상·길이 초과는 오류 */
export function parseChatReply(raw: string): string {
  const j = parseJsonSafe(raw);
  if (!isObj(j) || !Array.isArray(j.output)) throw new Error('BAD_RESPONSE');
  const texts: string[] = [];
  for (const it of j.output) {
    if (!isObj(it)) throw new Error('BAD_RESPONSE');
    if (it.type !== 'message') continue;
    if (!Array.isArray(it.content)) throw new Error('BAD_RESPONSE');
    for (const c of it.content) {
      if (!isObj(c)) throw new Error('BAD_RESPONSE');
      if (c.type === 'refusal') throw new Error('REFUSED');
      if (c.type === 'output_text') { if (typeof c.text !== 'string') throw new Error('BAD_RESPONSE'); texts.push(c.text); }
    }
  }
  if (j.status !== 'completed') throw new Error('INCOMPLETE');
  if (texts.length !== 1) throw new Error('BAD_RESPONSE');
  const t = texts[0]!.trim();
  if (t.length < 1 || t.length > MAX_REPLY_CHARS) throw new Error('BAD_RESPONSE');
  return t;
}

/** 응답 usage(불신) → 토큰 수. 형식이 틀리면 null(= 사용량 모름 → 호출자는 예약 기준으로 보수 정산) */
export function parseUsage(raw: string): { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null {
  const j = parseJsonSafe(raw);
  const u = isObj(j) ? j.usage : null;
  if (!isObj(u)) return null;
  const cached = isObj(u.input_tokens_details) ? u.input_tokens_details.cached_tokens : 0;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000;
  if (!ok(u.input_tokens) || !ok(u.output_tokens) || !ok(cached) || cached > u.input_tokens) return null;
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedInputTokens: cached };
}

const enc = new TextEncoder();
/** 설정이 유효하지 않아도 객체는 만든다(호출 시 ModelNotCalledError). 상담 경로 연결은 별도 승인 */
export function createOpenAiChatModel(config: OpenAiChatModelConfig | null): ChatModel {
  return Object.freeze({
    name: 'openai',
    costPerCallKrw: valid(config) ? config.costPerCallKrw : 1,
    async generate(input: ModelInput, signal: AbortSignal, meter?: CallMeter): Promise<string> {
      if (!valid(config)) throw new ModelNotCalledError('NOT_CONFIGURED');
      // P0 외부 전송 직전 최종 검사: 개인정보 모양이 남아 있으면 보내지 않는다(전송 0회 → 예약 취소)
      if (!isSafeModelInput(input)) throw new ModelNotCalledError('PII_BLOCKED');
      if (!hasBudgetPermit(meter)) throw new ModelNotCalledError('NO_BUDGET_PERMIT'); // 비용 게이트 우회(직접 호출) 차단
      if (signal.aborted) throw new ModelNotCalledError('ABORTED');
      const bodyText = buildChatBody(config.model, input, config.maxOutputTokens);
      if (inputTokenUpperBound(bodyText) > config.maxInputTokens) throw new ModelNotCalledError('INPUT_TOO_LARGE');
      const r = await boundedRequest(config.transport, config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: enc.encode(bodyText),
      }, { deadlineAt: Date.now() + config.timeoutMs, maxResponseBytes: config.maxResponseBytes, signal });
      if (r.kind === 'error' && !r.sent) throw new ModelNotCalledError(r.code);
      // 실패 종류만 구분한다(재시도 여부는 modelRecovery가 정한다): 429·5xx·timeout·네트워크 = 재시도 가능, 4xx·응답 형식·거절 = 불가
      if (r.kind === 'http') throw new ModelCallError(r.status === 429 ? 'HTTP_RATE_LIMITED' : 'HTTP_ERROR', r.status === 429 ? 'rate_limited' : r.status >= 500 ? 'server' : 'client', r.status, r.retryAfterSec === undefined ? undefined : r.retryAfterSec * 1000);
      if (r.kind === 'error') throw new ModelCallError(r.code, r.code === 'TIMEOUT' ? 'timeout' : r.code === 'TRANSPORT_ERROR' ? 'network' : 'response');
      // 실제 사용량 비용(원, 올림): 1원 이상·이 호출 예약 이하로 자른다. 모르면 meter에 남기지 않는다(→ 예약 기준 보수 정산)
      const p = priceFor(config.prices, config.model);
      const usage = parseUsage(r.text);
      const k = p && usage ? settleKrw(p, usage) : null;
      if (meter && k !== null) { meter.usageKrw = (meter.usageKrw ?? 0) + Math.max(1, Math.min(config.costPerCallKrw, k)); meter.usageCount = (meter.usageCount ?? 0) + 1; }
      try { return parseChatReply(r.text); } catch (e) { throw new ModelCallError(e instanceof Error ? e.message : 'BAD_RESPONSE', 'response'); }
    },
  });
}

/** 상담 1회 호출 상한(코드 고정, 환경변수로 바꾸지 않는다). 예약 비용 = 이 상한으로 계산한 예상 최대 비용(원, 올림) */
export const CONSULT_CALL_LIMITS = Object.freeze({ maxInputTokens: 4000, maxOutputTokens: 512, // PM 11/24 A안: 200은 실제 상담 프롬프트에서 답 잘림(INCOMPLETE) → 512(1회 예약 3원)
  timeoutMs: 7000, maxResponseBytes: 32768 }); // PM 11/24 보완: 실측 2.4~4.0초 → 3.5초는 정상 지연에도 실패, 1회 7초 // 응답 바이트 상한: 실제 Responses API 응답(메타데이터 포함)이 8KB를 넘음 → 32KB(PM 11/24 ④ LIVE0 실측, 비용 무관)

/** 상담 라우트 재시도 시간(PM 11/24 보완): 1회 7초·전체 7초 — 첫 시도가 시간 초과면 재시도 없음(보낸 1회분만 정산), 빠른 5xx면 남은 시간 안에서 1회 재시도. 상담 전체 제한(8초) 이내 */
export const CONSULT_RECOVERY_TIMING = Object.freeze({ attemptMs: 7000, totalMs: 7000 });

const VERIFIED_KRW_PRICES = verifiedKrwPrices(); // 공식 확인 기록 → 원화 가격표(모듈당 1번, 고정)
let last: { sig: string; transport: BodyTransport | null; prices: readonly ModelPrice[]; model: ChatModel } | null = null;
/**
 * 상담 경로 모델 선택(PM 11/24). CONSULT_AI_MODEL:
 * - 'mock' → 무료 모의 모델(createModel 그대로)
 * - 가격표(공식 확인 기록 → 1,800원/USD 보수 환율 원화표)에 정확히 1개 있는 모델 ID → 어댑터. 예약 비용은 가격표로만 계산(환경변수 비용 없음)
 * - 그 밖(오타·대소문자·날짜 붙은 ID·가격표 이상) → null(단가 불확실 = 호출 금지)
 * 실행은 CONSULT_AI_EXECUTION === 'allow' + 키 + 주소 + transport가 모두 있어야 한다(하나라도 없으면 전송 0회, 예약 취소).
 * 같은 설정이면 같은 객체를 돌려준다(복구 차단기 상태 유지).
 */
export function consultModelFromEnv(env: Record<string, string | undefined>, transport: BodyTransport | null, prices: readonly ModelPrice[] = VERIFIED_KRW_PRICES): ChatModel | null {
  const name = env.CONSULT_AI_MODEL;
  if (name === 'mock') return env.VERCEL_ENV === 'production' ? null : createModel(env); // PM 11/24 ④: 모의 모델은 운영 배포 금지(시험·로컬·미리보기 전용)
  if (typeof name !== 'string') return null;
  const p = priceFor(prices, name);
  if (!p) return null;
  const L = CONSULT_CALL_LIMITS;
  const cost = estimateMaxKrw(p, L.maxInputTokens, L.maxOutputTokens);
  if (cost === null || cost < 1 || cost > 1000) return null;
  const sig = JSON.stringify([name, env.CONSULT_AI_ENDPOINT ?? null, env.CONSULT_AI_API_KEY ?? null, env.CONSULT_AI_EXECUTION ?? null, cost]);
  if (last && last.sig === sig && last.transport === transport && last.prices === prices) return last.model;
  const model = createOpenAiChatModel({
    transport, endpoint: env.CONSULT_AI_ENDPOINT ?? null, apiKey: env.CONSULT_AI_API_KEY ?? null, model: name,
    executionAllowed: env.CONSULT_AI_EXECUTION === 'allow', costPerCallKrw: cost, prices: [p], ...L,
  });
  last = { sig, transport, prices, model };
  return model;
}
