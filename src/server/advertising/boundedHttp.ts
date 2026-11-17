import 'server-only';
// 주입식 HTTP 1회 요청 보조 (PM 6951004870). 검수된 openAiAdGenerator의 마감·바이트 상한 패턴을 따른다.
// - transport는 필수 주입(fetch Response형: status + body 스트림). 기본 fetch·env·SDK·재시도 없음.
// - 절대 마감(deadlineAt, 여러 요청이 공유 가능): 남은 시간이 없으면 transport 0. 마감 시 AbortSignal을 보내고 진행 중 reader를 취소한다. 마감 뒤 도착한 응답은 본문을 읽지 않고 취소만 한다.
//   취소는 기다리지 않는다(정리가 막혀도 반환 지연 없음). 취소가 실제 전송·업로드·청구 취소를 보장하지는 않는다.
// - 바이트 상한: chunk마다 실제 바이트를 세고 넘는 순간 읽기 취소. 실제 최대 수신량은 상한 + 마지막 chunk 크기다.
// - 2xx가 아니면 본문을 읽지 않는다(오류 본문 반사 없음).
// - 응답 속성(status·body)은 한 번만 읽는다. read reject·getReader 예외·접근자 예외 등 모든 실패에서 소유한 reader/body를 정리한다.
// - 반환은 고정 코드와 sent(transport 호출 여부)뿐이다. 예외 원문·헤더·URL은 내보내지 않는다.

export type BodyTransport = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: Uint8Array; signal: AbortSignal; redirect: 'error' },
) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>;

export type BoundedResult =
  | { readonly kind: 'ok'; readonly status: number; readonly text: string }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'error'; readonly code: 'TIMEOUT' | 'TOO_LARGE' | 'TRANSPORT_ERROR' | 'BAD_RESPONSE'; readonly sent: boolean };

type Reader = ReadableStreamDefaultReader<Uint8Array>;

const cancelQuiet = (x: { cancel?: () => Promise<unknown> } | null | undefined): void => {
  try {
    const p = x && typeof x.cancel === 'function' ? x.cancel() : null;
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => undefined);
  } catch {
    /* 무시 */
  }
};

const E = (code: Extract<BoundedResult, { kind: 'error' }>['code'], sent: boolean): BoundedResult => Object.freeze({ kind: 'error', code, sent });

/**
 * 1회 요청. limits.deadlineAt은 **절대 마감 시각**(Date.now() 기준 ms)이다. 여러 요청이 같은 마감을 공유할 수 있다.
 * 남은 시간이 없으면 transport를 부르지 않는다(sent:false).
 */
export async function boundedRequest(
  transport: BodyTransport,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: Uint8Array },
  limits: { deadlineAt: number; maxResponseBytes: number },
): Promise<BoundedResult> {
  const remaining = limits.deadlineAt - Date.now();
  if (!(remaining > 0)) return E('TIMEOUT', false);
  const ac = new AbortController();
  let expired = false;
  let sent = false;
  let ownedBody: ReadableStream<Uint8Array> | null = null;
  let activeReader: Reader | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 소유한 reader 또는 body를 정리한다(기다리지 않음)
  const cleanup = () => {
    if (activeReader) cancelQuiet(activeReader);
    else cancelQuiet(ownedBody);
  };
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      ac.abort();
      cleanup();
      resolve('timeout');
    }, remaining);
  });

  const readBody = async (reader: Reader, chunks: Uint8Array[], total: number): Promise<BoundedResult | Uint8Array[]> => {
    const step = await reader.read();
    if (expired) {
      cancelQuiet(reader);
      return E('TIMEOUT', true);
    }
    if (step.done) return chunks;
    const v = step.value;
    if (!(v instanceof Uint8Array)) {
      cancelQuiet(reader);
      return E('BAD_RESPONSE', true);
    }
    const next = total + v.byteLength;
    if (next > limits.maxResponseBytes) {
      cancelQuiet(reader);
      return E('TOO_LARGE', true);
    }
    chunks.push(v);
    return readBody(reader, chunks, next);
  };

  const call = (async (): Promise<BoundedResult> => {
    sent = true;
    const res = await transport(url, { ...init, signal: ac.signal, redirect: 'error' });
    // 응답 속성은 각각 한 번만 읽는다(접근자 예외 → 고정 실패)
    let status: unknown;
    try {
      ownedBody = res && typeof res === 'object' ? (res.body as ReadableStream<Uint8Array> | null) : null;
      status = res && typeof res === 'object' ? res.status : undefined;
    } catch {
      cleanup();
      return E('BAD_RESPONSE', true);
    }
    if (expired) {
      cleanup(); // 마감 뒤 도착: 본문을 읽지 않고 정리만
      return E('TIMEOUT', true);
    }
    if (typeof status !== 'number' || !Number.isInteger(status)) {
      cleanup();
      return E('BAD_RESPONSE', true);
    }
    if (status < 200 || status >= 300) {
      cleanup();
      return Object.freeze({ kind: 'http', status });
    }
    const body = ownedBody;
    if (!body || typeof body !== 'object') return E('BAD_RESPONSE', true);
    try {
      activeReader = body.getReader();
    } catch {
      cleanup();
      return E('BAD_RESPONSE', true);
    }
    let got: BoundedResult | Uint8Array[];
    try {
      got = await readBody(activeReader, [], 0);
    } catch {
      cleanup(); // read reject → 소유한 reader 취소
      return E('TRANSPORT_ERROR', true);
    }
    if (!Array.isArray(got)) return got;
    if (expired) return E('TIMEOUT', true);
    const all = new Uint8Array(got.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of got) {
      all.set(c, off);
      off += c.byteLength;
    }
    try {
      return Object.freeze({ kind: 'ok', status, text: new TextDecoder('utf-8', { fatal: true }).decode(all) });
    } catch {
      return E('BAD_RESPONSE', true);
    }
  })().catch(() => {
    cleanup();
    return E('TRANSPORT_ERROR', sent);
  });

  try {
    const r = await Promise.race([call, deadline]);
    return r === 'timeout' ? E('TIMEOUT', sent) : r;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 불신 JSON 파싱(예외 → null) */
export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
