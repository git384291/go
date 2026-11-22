import 'server-only';
// 상담 AI 실제 모델 어댑터 — **인터페이스·모의시험 전용 준비 코드(PM 11/22 4c7f269 지시 9). 상담 경로에 연결하지 않았다.**
// - createModel(chatModel.ts)은 여전히 'mock'만 돌려준다. 이 어댑터를 쓰려면 별도 승인(비용 한도·모델·키)과 연결 변경이 필요하다.
// - 계약은 광고 소재 어댑터(openAiAdGenerator.ts)와 같은 OpenAI Responses API 형식(POST /v1/responses, store:false, tools 없음).
//   Claude 환경에서 공식 원문을 이번에 다시 열람하지 않았다. 실제 모델명·가격·응답 형식은 연결 승인 시 공식 문서로 다시 확인한다.
// - transport·키·모델·실행 허용은 모두 명시 주입(환경변수·기본 클라이언트 없음). 설정이 없거나 허용이 아니면 ModelNotCalledError(전송 0회 → 예약 취소).
// - 입력은 chatAnswer가 이미 가린 고객 글(maskPii)과 서버가 만든 승인 안내문뿐이다. 이 어댑터는 다른 고객 정보를 받지 않는다.
// - 출력은 그대로 믿지 않는다: chatAnswer가 금액·혜택 가드(guardAiReply·benefitClaimsAllowed)로 다시 검사하고, 실패하면 승인 안내문으로 대체한다.
// - 1요청 1호출, 재시도 없음, 응답 크기 상한, 마감 시각 초과 시 중단. 오류 본문·헤더·키는 반사하지 않는다.
import { boundedRequest, parseJsonSafe, type BodyTransport } from '../advertising/boundedHttp';
import { ModelNotCalledError, type ChatModel, type ModelInput } from './chatModel';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const MAX_REPLY_CHARS = 600;

export type OpenAiChatModelConfig = {
  readonly transport: BodyTransport | null;
  readonly apiKey: string | null;
  readonly model: string | null;
  /** 정확히 true일 때만 전송한다 */
  readonly executionAllowed: unknown;
  /** 1회 호출 예약 비용(원). DB 월 한도(기본 0원) 예약에 쓴다. 1 이상 정수 */
  readonly costPerCallKrw: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const valid = (c: OpenAiChatModelConfig | null): c is OpenAiChatModelConfig & { transport: BodyTransport; apiKey: string; model: string } =>
  !!c && c.executionAllowed === true && typeof c.transport === 'function' &&
  typeof c.apiKey === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(c.apiKey) &&
  typeof c.model === 'string' && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(c.model) &&
  Number.isSafeInteger(c.costPerCallKrw) && c.costPerCallKrw >= 1 && c.costPerCallKrw <= 1000 &&
  Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16 && c.maxOutputTokens <= 512 &&
  Number.isSafeInteger(c.timeoutMs) && c.timeoutMs >= 1000 && c.timeoutMs <= 15000 &&
  Number.isSafeInteger(c.maxResponseBytes) && c.maxResponseBytes >= 1024 && c.maxResponseBytes <= 65536;

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

const enc = new TextEncoder();
/** 설정이 유효하지 않아도 객체는 만든다(호출 시 ModelNotCalledError). 상담 경로 연결은 별도 승인 */
export function createOpenAiChatModel(config: OpenAiChatModelConfig | null): ChatModel {
  return Object.freeze({
    name: 'openai',
    costPerCallKrw: valid(config) ? config.costPerCallKrw : 1,
    async generate(input: ModelInput, signal: AbortSignal): Promise<string> {
      if (!valid(config)) throw new ModelNotCalledError('NOT_CONFIGURED');
      if (signal.aborted) throw new ModelNotCalledError('ABORTED');
      const r = await boundedRequest(config.transport, OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: enc.encode(buildChatBody(config.model, input, config.maxOutputTokens)),
      }, { deadlineAt: Date.now() + config.timeoutMs, maxResponseBytes: config.maxResponseBytes });
      if (r.kind === 'error' && !r.sent) throw new ModelNotCalledError(r.code);
      if (r.kind !== 'ok') throw new Error(r.kind === 'http' ? `HTTP_${r.status === 429 ? 'RATE_LIMITED' : 'ERROR'}` : r.code);
      return parseChatReply(r.text);
    },
  });
}
