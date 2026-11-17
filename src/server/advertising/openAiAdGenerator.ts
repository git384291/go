import 'server-only';
// OpenAI Responses API 광고 소재 생성 어댑터 (PM 6943345830). **비활성 준비 코드: 실제 키·모델·연결 없음, 실호출 0.**
//
// 계약(PM이 2026-11-17 확인한 공식 자료 기준. Claude 환경에서는 원문 미열람):
//   https://developers.openai.com/api/reference/resources/responses/methods/create
//   https://developers.openai.com/api/docs/guides/structured-outputs
// - POST https://api.openai.com/v1/responses 고정(endpoint 변경·redirect 없음, redirect:'error').
// - body: model, instructions, input, store:false, max_output_tokens, text.format = json_schema(strict) — tools 없음.
// - 응답: HTTP JSON의 output 배열에서 type:'message' → content의 type:'output_text' 텍스트를 읽는다(SDK 전용 output_text 편의 필드에 의존하지 않음).
//   type:'refusal'이면 REFUSED, status가 'completed'가 아니면 INCOMPLETE.
// - transport·credential·model·실행 허용은 **모두 명시 주입**이다. 환경변수·기본 키·기본 클라이언트·자동 접속이 없다.
//   설정이 없거나 실행 허용이 false면 transport를 부르지 않는다(NOT_CONFIGURED).
// - 1요청당 1호출. 자동 재시도·백그라운드·예약·대량 생성 없음.
// - 호출당 deadline: 마감 시 AbortSignal을 보내고, 진행 중인 본문 reader를 취소한다. 마감 뒤에 도착한 응답은 본문을 읽지 않고
//   취소한다(취소 완료를 기다리지 않으므로 정리가 막혀도 반환은 지연되지 않는다). 취소가 전송·청구 취소를 보장하지는 않는다.
// - 응답 크기 상한(maxResponseBytes): 실제로 받은 바이트를 chunk마다 세어 넘는 순간 읽기를 취소한다. 넘긴 chunk 하나는 이미
//   메모리에 들어온 상태이므로 실제 최대 수신량은 상한 + 마지막 chunk 크기다(transport가 주는 chunk 크기에 따름).
// - 오류는 고정 코드만 돌려준다. API 오류 본문·헤더·키·요청 ID는 반사하지 않는다.
// - store:false는 모든 보관이 0이라는 보증이 아니다. max_output_tokens는 원화 청구 강제 상한이 아니다.
//   실제 모델명·가격·지원 여부는 확인하지 않았다(모델명·비용을 지어내지 않는다).
import type { AdCopyGenerator, AdPrompt, GeneratorOutcome } from './adGeneration';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * fetch형 transport(필수 주입). fetch의 Response처럼 status와 body(ReadableStream)를 돌려준다.
 * 본문은 이 어댑터가 reader로 직접 읽으며 바이트 상한을 넘으면 즉시 읽기를 취소한다(Content-Length는 믿지 않는다).
 */
export type HttpTransport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' },
) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>;

export type OpenAiAdGeneratorConfig = {
  readonly transport: HttpTransport | null;
  readonly apiKey: string | null;
  readonly model: string | null;
  /** 정확히 true일 때만 호출한다 */
  readonly executionAllowed: unknown;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
};

/** 모델이 따라야 하는 strict JSON schema(제목·설명 두 필드). 길이 제한은 strict 모드 지원 여부를 확인하지 않아 스키마에 넣지 않고 서버 검증(validateAdCopy)으로 강제한다 */
export const AD_COPY_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    title: Object.freeze({ type: 'string' }),
    description: Object.freeze({ type: 'string' }),
  }),
  required: Object.freeze(['title', 'description']),
  additionalProperties: false,
});

const outcome = (o: GeneratorOutcome): GeneratorOutcome => Object.freeze(o);
const err = (code: Extract<GeneratorOutcome, { kind: 'error' }>['code'], called: boolean) => outcome({ kind: 'error', code, called });

const validConfig = (c: OpenAiAdGeneratorConfig | null | undefined): c is OpenAiAdGeneratorConfig & { transport: HttpTransport; apiKey: string; model: string } =>
  !!c &&
  c.executionAllowed === true &&
  typeof c.transport === 'function' &&
  typeof c.apiKey === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(c.apiKey) &&
  typeof c.model === 'string' && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(c.model) &&
  Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16 && c.maxOutputTokens <= 512 &&
  Number.isSafeInteger(c.timeoutMs) && c.timeoutMs >= 1000 && c.timeoutMs <= 30000 &&
  Number.isSafeInteger(c.maxResponseBytes) && c.maxResponseBytes >= 1024 && c.maxResponseBytes <= 65536;

/** 요청 본문(고정 구조). 시험에서 정확히 대조한다 */
export function buildResponsesBody(model: string, prompt: AdPrompt, maxOutputTokens: number): string {
  return JSON.stringify({
    model,
    instructions: prompt.instructions,
    input: prompt.input,
    store: false,
    max_output_tokens: maxOutputTokens,
    text: { format: { type: 'json_schema', name: 'ad_copy', strict: true, schema: AD_COPY_SCHEMA } },
  });
}

/** HTTP 응답 본문(불신)에서 구조화 출력 텍스트 1개를 꺼낸다 */
export function parseResponsesBody(raw: string): GeneratorOutcome {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return err('BAD_RESPONSE', true);
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return err('BAD_RESPONSE', true);
  const r = j as Record<string, unknown>;
  if (!Array.isArray(r.output)) return err('BAD_RESPONSE', true);
  const texts: string[] = [];
  for (const item of r.output) {
    if (!item || typeof item !== 'object') return err('BAD_RESPONSE', true);
    const it = item as Record<string, unknown>;
    if (it.type !== 'message') continue; // 추론 등 다른 항목은 읽지 않는다
    if (!Array.isArray(it.content)) return err('BAD_RESPONSE', true);
    for (const c of it.content) {
      if (!c || typeof c !== 'object') return err('BAD_RESPONSE', true);
      const cc = c as Record<string, unknown>;
      if (cc.type === 'refusal') return err('REFUSED', true);
      if (cc.type === 'output_text') {
        if (typeof cc.text !== 'string') return err('BAD_RESPONSE', true);
        texts.push(cc.text);
      }
    }
  }
  if (r.status !== 'completed') return err('INCOMPLETE', true);
  if (texts.length !== 1) return err('BAD_RESPONSE', true);
  let data: unknown;
  try {
    data = JSON.parse(texts[0]!);
  } catch {
    return err('BAD_RESPONSE', true);
  }
  return outcome({ kind: 'ok', data, called: true });
}

/**
 * 비활성 기본의 어댑터. 설정이 하나라도 없거나 executionAllowed !== true면 transport를 부르지 않는다.
 * 기본 설정·환경변수를 읽지 않는다. 반환 객체는 생성 오케스트레이터에 주입한다.
 */
type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** 결과를 기다리지 않는 정리(정리 실패·지연이 반환을 막지 않게) */
const cancelQuiet = (x: { cancel?: () => Promise<unknown> } | null | undefined): void => {
  try {
    const p = x && typeof x.cancel === 'function' ? x.cancel() : null;
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => undefined);
  } catch {
    /* 무시 */
  }
};

/**
 * 비활성 기본의 어댑터. 설정이 하나라도 없거나 executionAllowed !== true면 transport를 부르지 않는다.
 * 기본 설정·환경변수를 읽지 않는다. 반환 객체는 생성 오케스트레이터에 주입한다.
 */
export function createOpenAiAdGenerator(config: OpenAiAdGeneratorConfig | null): AdCopyGenerator {
  return Object.freeze({
    generate: async (prompt: AdPrompt): Promise<GeneratorOutcome> => {
      if (!validConfig(config)) return err('NOT_CONFIGURED', false);
      const { transport, apiKey, model, maxOutputTokens, timeoutMs, maxResponseBytes } = config;
      const ac = new AbortController();
      let expired = false;
      let activeReader: Reader | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          ac.abort();
          cancelQuiet(activeReader); // 멈춘 read도 풀어 준다
          resolve('timeout');
        }, timeoutMs);
      });

      // 본문을 chunk 단위로 읽는다. 매 await 뒤 마감·상한을 확인한다(재귀, 재시도 아님)
      const readBody = async (reader: Reader, chunks: Uint8Array[], total: number): Promise<GeneratorOutcome | Uint8Array[]> => {
        const step = await reader.read();
        if (expired) {
          cancelQuiet(reader);
          return err('TIMEOUT', true);
        }
        if (step.done) return chunks;
        const v = step.value;
        if (!(v instanceof Uint8Array)) {
          cancelQuiet(reader);
          return err('BAD_RESPONSE', true);
        }
        const next = total + v.byteLength;
        if (next > maxResponseBytes) {
          cancelQuiet(reader);
          return err('TOO_LARGE', true);
        }
        chunks.push(v);
        return readBody(reader, chunks, next);
      };

      const call = (async (): Promise<GeneratorOutcome> => {
        const res = await transport(OPENAI_RESPONSES_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: buildResponsesBody(model, prompt, maxOutputTokens),
          signal: ac.signal,
          redirect: 'error',
        });
        const body = res && typeof res === 'object' ? res.body : null;
        if (expired) {
          cancelQuiet(body); // 마감 뒤 도착: 본문을 읽지 않고 정리만
          return err('TIMEOUT', true);
        }
        if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
          cancelQuiet(body);
          return err('BAD_RESPONSE', true);
        }
        if (res.status === 429 || res.status < 200 || res.status >= 300) {
          cancelQuiet(body); // 오류 본문은 읽지도 반사하지도 않는다
          return err(res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', true);
        }
        if (!body || typeof body.getReader !== 'function') return err('BAD_RESPONSE', true);
        const reader = body.getReader();
        activeReader = reader;
        const got = await readBody(reader, [], 0);
        activeReader = null;
        if (!Array.isArray(got)) return got;
        if (expired) return err('TIMEOUT', true);
        const all = new Uint8Array(got.reduce((n, c) => n + c.byteLength, 0));
        let off = 0;
        for (const c of got) {
          all.set(c, off);
          off += c.byteLength;
        }
        let raw: string;
        try {
          raw = new TextDecoder('utf-8', { fatal: true }).decode(all);
        } catch {
          return err('BAD_RESPONSE', true);
        }
        return parseResponsesBody(raw);
      })().catch(() => err('TRANSPORT_ERROR', true));

      try {
        const r = await Promise.race([call, deadline]);
        return r === 'timeout' ? err('TIMEOUT', true) : r;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}
