import 'server-only';
// 상담 AI 무료 등급(Gemini) 어댑터 — PM 11/26 승인: 개발 시험 한정·가짜 상담 데이터만·유료 호출 금지·기존 OpenAI 코드 보존.
// - 안전장치는 OpenAI 어댑터와 같은 것을 그대로 쓴다: 전송 직전 개인정보 검사(isSafeModelInput), 비용 게이트 허가(hasBudgetPermit),
//   DB 하드 한도(예약 → 확정/취소, 기본 0원), 마감 시각·응답 크기 상한, 복구 래퍼(modelRecovery) 바깥 재시도 금지, 오류 본문·키 반사 금지.
// - 무료 호출도 1회 = 1원 '요청 단위'로 DB 한도에 센다(실제 청구액이 아니라 요청 횟수 상한용). 한도를 올리지 않으면(기본 0원) 호출 0회.
// - **운영·환경 불명에서는 모델을 만들지 않는다(freeTierEnvAllowed, 허용 목록)**: 무료 등급은 입력이 구글 제품 개선에 쓰일 수 있어 실제 고객 상담을 보낼 수 없다.
// - 키가 결제 연결된 프로젝트의 것이면 무료가 아니다 → 개발용 키는 결제 수단이 없는 별도 프로젝트에서 받아야 한다(운영 문서 참조).
// - 요청·응답 형식: generateContent(systemInstruction·contents·generationConfig / candidates·usageMetadata). 공식 문서와 실제 응답으로 확인 필요(키 연결 후 실측).
import { boundedRequest, parseJsonSafe, type BodyTransport } from '@/server/advertising/boundedHttp';
import { geminiEndpointFor, GEMINI_MODEL_ID } from '@/server/ai/geminiTransport';
import { hasBudgetPermit, ModelNotCalledError, type CallMeter, type ChatModel, type ModelInput } from './chatModel';
import { inputTokenUpperBound } from '@/server/ai/costModel';
import { ModelCallError } from './modelRecovery';
import { isSafeModelInput } from './piiBoundary';
import { CONSULT_CALL_LIMITS, MAX_REPLY_CHARS } from './openAiChatModel';

/** 무료 호출 1회에 DB 한도로 예약하는 '요청 단위'(원). 실제 비용 0원, 요청 횟수 상한용 */
export const GEMINI_FREE_UNIT_KRW = 1;

export type GeminiChatModelConfig = {
  readonly transport: BodyTransport | null;
  /** 요청 주소(geminiEndpointFor로 만든 값만) */
  readonly endpoint: string | null;
  readonly apiKey: string | null;
  readonly model: string | null;
  /** 정확히 true일 때만 전송한다 */
  readonly executionAllowed: unknown;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxInputTokens: number;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const valid = (c: GeminiChatModelConfig | null): c is GeminiChatModelConfig & { transport: BodyTransport; endpoint: string; apiKey: string; model: string } =>
  !!c && c.executionAllowed === true && typeof c.transport === 'function' &&
  typeof c.model === 'string' && GEMINI_MODEL_ID.test(c.model) &&
  typeof c.endpoint === 'string' && c.endpoint === geminiEndpointFor(c.model) &&
  typeof c.apiKey === 'string' && /^[A-Za-z0-9_.-]{20,200}$/.test(c.apiKey) &&
  Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16 && c.maxOutputTokens <= 512 &&
  Number.isSafeInteger(c.timeoutMs) && c.timeoutMs >= 1000 && c.timeoutMs <= 15000 &&
  Number.isSafeInteger(c.maxResponseBytes) && c.maxResponseBytes >= 1024 && c.maxResponseBytes <= 65536 &&
  Number.isSafeInteger(c.maxInputTokens) && c.maxInputTokens >= 64 && c.maxInputTokens <= 20000;

/** 요청 본문(고정 구조). 고객 글은 가린 뒤의 글만, 승인 안내문은 서버 문장만. 검색·도구·코드 실행 없음 */
export function buildGeminiBody(input: ModelInput, maxOutputTokens: number): string {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: input.system }] },
    contents: [{ role: 'user', parts: [{ text: `[승인 안내문]\n${input.approved}\n\n[고객 문의(개인정보 가림)]\n${input.user}` }] }],
    generationConfig: { maxOutputTokens, candidateCount: 1 },
  });
}

/** 응답(불신)에서 답변 1개만 꺼낸다. 차단·미완료·형식 이상·길이 초과는 오류 */
export function parseGeminiReply(raw: string): string {
  const j = parseJsonSafe(raw);
  if (!isObj(j)) throw new Error('BAD_RESPONSE');
  if (isObj(j.promptFeedback) && typeof j.promptFeedback.blockReason === 'string') throw new Error('REFUSED');
  if (!Array.isArray(j.candidates) || j.candidates.length !== 1) throw new Error('BAD_RESPONSE');
  const cand = j.candidates[0];
  if (!isObj(cand)) throw new Error('BAD_RESPONSE');
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT' || cand.finishReason === 'BLOCKLIST' || cand.finishReason === 'SPII') throw new Error('REFUSED');
  if (cand.finishReason !== 'STOP') throw new Error('INCOMPLETE');
  const parts = isObj(cand.content) ? cand.content.parts : null;
  if (!Array.isArray(parts)) throw new Error('BAD_RESPONSE');
  const texts: string[] = [];
  for (const p of parts) {
    if (!isObj(p)) throw new Error('BAD_RESPONSE');
    if (p.thought === true) continue; // 생각 요약은 답변이 아니다
    if (typeof p.text !== 'string') throw new Error('BAD_RESPONSE'); // 함수 호출·코드 실행·파일 등은 받지 않는다
    texts.push(p.text);
  }
  if (texts.length < 1) throw new Error('BAD_RESPONSE');
  const t = texts.join('').trim();
  if (t.length < 1 || t.length > MAX_REPLY_CHARS) throw new Error('BAD_RESPONSE');
  return t;
}

/** 사용량 확인용(불신). 형식이 틀리면 null. 무료 등급은 비용이 0원이라 정산은 요청 단위(1원)로 한다 */
export function parseGeminiUsage(raw: string): { inputTokens: number; outputTokens: number } | null {
  const j = parseJsonSafe(raw);
  const u = isObj(j) ? j.usageMetadata : null;
  if (!isObj(u)) return null;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000;
  const thoughts = u.thoughtsTokenCount === undefined ? 0 : u.thoughtsTokenCount;
  if (!ok(u.promptTokenCount) || !ok(u.candidatesTokenCount) || !ok(thoughts)) return null;
  return { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount + thoughts };
}

const enc = new TextEncoder();
/** 설정이 유효하지 않아도 객체는 만든다(호출 시 ModelNotCalledError) */
export function createGeminiChatModel(config: GeminiChatModelConfig | null): ChatModel {
  return Object.freeze({
    name: 'gemini-free',
    costPerCallKrw: GEMINI_FREE_UNIT_KRW,
    async generate(input: ModelInput, signal: AbortSignal, meter?: CallMeter): Promise<string> {
      if (!valid(config)) throw new ModelNotCalledError('NOT_CONFIGURED');
      // P0 외부 전송 직전 최종 검사: 개인정보 모양이 남아 있으면 보내지 않는다(전송 0회 → 예약 취소)
      if (!isSafeModelInput(input)) throw new ModelNotCalledError('PII_BLOCKED');
      if (!hasBudgetPermit(meter)) throw new ModelNotCalledError('NO_BUDGET_PERMIT'); // 비용 게이트 우회(직접 호출) 차단
      if (signal.aborted) throw new ModelNotCalledError('ABORTED');
      const bodyText = buildGeminiBody(input, config.maxOutputTokens);
      if (inputTokenUpperBound(bodyText) > config.maxInputTokens) throw new ModelNotCalledError('INPUT_TOO_LARGE');
      const r = await boundedRequest(config.transport, config.endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' },
        body: enc.encode(bodyText),
      }, { deadlineAt: Date.now() + config.timeoutMs, maxResponseBytes: config.maxResponseBytes, signal });
      if (r.kind === 'error' && !r.sent) throw new ModelNotCalledError(r.code);
      // 실패 종류만 구분한다(재시도 여부는 modelRecovery가 정한다): 429·5xx·timeout·네트워크 = 재시도 가능, 4xx·응답 형식·차단 = 불가
      if (r.kind === 'http') throw new ModelCallError(r.status === 429 ? 'HTTP_RATE_LIMITED' : 'HTTP_ERROR', r.status === 429 ? 'rate_limited' : r.status >= 500 ? 'server' : 'client', r.status, r.retryAfterSec === undefined ? undefined : r.retryAfterSec * 1000);
      if (r.kind === 'error') throw new ModelCallError(r.code, r.code === 'TIMEOUT' ? 'timeout' : r.code === 'TRANSPORT_ERROR' ? 'network' : 'response');
      // 사용량 형식이 맞을 때만 이 호출을 요청 단위 1원으로 정산한다(실제 비용 0원). 모르면 meter에 남기지 않는다(→ 예약 기준 보수 정산, 역시 1원)
      if (meter && parseGeminiUsage(r.text) !== null) { meter.usageKrw = (meter.usageKrw ?? 0) + GEMINI_FREE_UNIT_KRW; meter.usageCount = (meter.usageCount ?? 0) + 1; }
      try { return parseGeminiReply(r.text); } catch (e) { throw new ModelCallError(e instanceof Error ? e.message : 'BAD_RESPONSE', 'response'); }
    },
  });
}

/**
 * 무료 등급은 '알려진 개발·시험 환경'에서만 허용한다(허용 목록, fail-closed). 호스팅이 바뀌어 VERCEL_ENV가 없어져도 운영으로 새지 않는다:
 * Vercel 미리보기/개발, 명시 APP_ENV=dev, 로컬 개발·시험(NODE_ENV)만 true. VERCEL_ENV=production 또는 APP_ENV=production은 항상 false. 그 밖(환경 불명)도 false.
 */
export function freeTierEnvAllowed(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL_ENV === 'production' || env.APP_ENV === 'production') return false;
  return env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'development' || env.APP_ENV === 'dev' || env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

let last: { sig: string; transport: BodyTransport | null; model: ChatModel } | null = null;
/**
 * 환경 → 무료 Gemini 모델. 아래가 모두 맞을 때만 어댑터를 만든다(하나라도 아니면 null = 안전 안내문, 호출 0회):
 * - CONSULT_AI_PROVIDER === 'gemini-free', 운영(VERCEL_ENV=production) 아님, CONSULT_AI_MODEL이 gemini-… 형식
 * 실제 전송은 추가로 CONSULT_AI_EXECUTION === 'allow' + 키 + transport가 있어야 한다. 같은 설정이면 같은 객체(복구 차단기 상태 유지).
 */
export function geminiFreeModelFromEnv(env: Record<string, string | undefined>, transport: BodyTransport | null): ChatModel | null {
  if (env.CONSULT_AI_PROVIDER !== 'gemini-free') return null;
  if (!freeTierEnvAllowed(env)) return null; // 운영·환경 불명 금지(개인정보 보호, PM 11/26)
  const name = env.CONSULT_AI_MODEL;
  if (typeof name !== 'string' || !GEMINI_MODEL_ID.test(name)) return null;
  const sig = JSON.stringify([name, env.CONSULT_AI_API_KEY ?? null, env.CONSULT_AI_EXECUTION ?? null]);
  if (last && last.sig === sig && last.transport === transport) return last.model;
  const L = CONSULT_CALL_LIMITS;
  const model = createGeminiChatModel({
    transport, endpoint: geminiEndpointFor(name), apiKey: env.CONSULT_AI_API_KEY ?? null, model: name,
    executionAllowed: env.CONSULT_AI_EXECUTION === 'allow',
    maxOutputTokens: L.maxOutputTokens, timeoutMs: L.timeoutMs, maxResponseBytes: L.maxResponseBytes, maxInputTokens: L.maxInputTokens,
  });
  last = { sig, transport, model };
  return model;
}
