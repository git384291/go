// OpenAI Responses 어댑터(PM 6943345830) — 가짜 transport만. 실제 OpenAI 연결·요금·모델 지원 확인이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiAdGenerator, OPENAI_RESPONSES_URL, AD_COPY_SCHEMA, parseResponsesBody, type HttpTransport, type OpenAiAdGeneratorConfig } from '../../src/server/advertising/openAiAdGenerator';
import { buildAdPrompt, generateAdCopy } from '../../src/server/advertising/adGeneration';

const KEY = 'fake_test_key_0000000000000000';
const prompt = buildAdPrompt('moving');
const COPY = { title: '이사 전 인터넷·TV 확인', description: '새집 인터넷·TV 조건을 확인하세요. 설치 가능 여부는 별도 확인이 필요합니다.' };
const okBody = (data: unknown = COPY, status = 'completed') => JSON.stringify({
  id: 'resp_fake', object: 'response', status,
  output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(data), annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
type Call = { url: string; init: Parameters<HttpTransport>[1] };
/** 가짜 본문 스트림: pull 횟수·취소 여부를 기록한다 */
const stream = (chunks: Uint8Array[], opts: { hangAfter?: number; cancelThrows?: boolean; cancelHangs?: boolean } = {}) => {
  const st = { pulls: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      st.pulls++;
      if (opts.hangAfter !== undefined && i >= opts.hangAfter) return new Promise<void>(() => undefined); // 영원히 대기
      if (i < chunks.length) c.enqueue(chunks[i++]!);
      else c.close();
    },
    cancel() {
      st.cancelled = true;
      if (opts.cancelThrows) throw new Error('cancel failed sk-leak');
      if (opts.cancelHangs) return new Promise<void>(() => undefined);
    },
  }, { highWaterMark: 0 });
  return { body, st };
};
const enc = (s: string) => new TextEncoder().encode(s);
const transport = (status: number, body: string, delayMs = 0) => {
  const calls: Call[] = [];
  const streams: ReturnType<typeof stream>[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const s = stream([enc(body)]);
    streams.push(s);
    return { status, body: s.body };
  };
  return { t, calls, streams };
};
const allowAll = { async reserve() { return { async confirm() {}, async cancel() {}, async uncertain() {} }; } };
const cfg = (t: HttpTransport | null, over: Partial<OpenAiAdGeneratorConfig> = {}): OpenAiAdGeneratorConfig => ({
  transport: t, apiKey: KEY, model: 'fake-model-1', executionAllowed: true, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192,
  // 0025: 공통 비용 게이트(항상 허용하는 시험용 예산)·가상 가격표
  budget: allowAll, costPerCallKrw: 10, budgetScope: 'a'.repeat(64), prices: [{ model: 'fake-model-1', currency: 'KRW', inputKrwPerMTok: 100, outputKrwPerMTok: 400 }], maxInputTokens: 4000, ...over,
});

test('OA1 미설정·실행 허용 false·잘못된 설정 → transport 0회', async () => {
  const { t, calls } = transport(200, okBody());
  const bads: (OpenAiAdGeneratorConfig | null)[] = [
    null, cfg(null), cfg(t, { executionAllowed: false }), cfg(t, { executionAllowed: 'true' }), cfg(t, { apiKey: null }), cfg(t, { apiKey: 'short' }),
    cfg(t, { apiKey: KEY + '\n' }), cfg(t, { model: null }), cfg(t, { model: 'Bad Model' }), cfg(t, { maxOutputTokens: 0 }), cfg(t, { maxOutputTokens: 100000 }),
    cfg(t, { timeoutMs: 0 }), cfg(t, { timeoutMs: 600000 }), cfg(t, { maxResponseBytes: 10_000_000 }),
  ];
  for (const c of bads) assert.deepEqual(await createOpenAiAdGenerator(c).generate(prompt), { kind: 'error', code: 'NOT_CONFIGURED', called: false });
  assert.equal(calls.length, 0);
  assert.deepEqual(await generateAdCopy({ situationId: 'moving', product: 'internet-tv' }, { generator: createOpenAiAdGenerator(null) }),
    { ok: false, error: 'NOT_CONFIGURED', generatorCalled: false });
});

test('OA2 요청 계약: 고정 URL·헤더·body(store false·strict schema·토큰 상한·tools 없음)·redirect error·signal, 1회', async () => {
  const { t, calls } = transport(200, okBody());
  const r = await createOpenAiAdGenerator(cfg(t)).generate(prompt);
  assert.deepEqual(r, { kind: 'ok', data: COPY, called: true });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, OPENAI_RESPONSES_URL);
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'max_output_tokens', 'model', 'store', 'text']);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 200);
  assert.equal(body.model, 'fake-model-1');
  assert.equal(body.instructions, prompt.instructions);
  assert.equal(body.input, prompt.input);
  assert.ok(!('tools' in body) && !('background' in body) && !('stream' in body));
  assert.deepEqual(body.text, { format: { type: 'json_schema', name: 'ad_copy', strict: true, schema: JSON.parse(JSON.stringify(AD_COPY_SCHEMA)) } });
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.deepEqual(body.text.format.schema.required, ['title', 'description']);
});

test('OA3 HTTP 오류·429·非JSON·이상 구조·refusal·incomplete → 고정 코드, 본문 반사 없음, 재시도 0', async () => {
  const cases: [number, string, string][] = [
    [429, '{"error":{"message":"rate limit sk-leak"}}', 'RATE_LIMITED'],
    [401, '{"error":{"message":"bad key sk-leak"}}', 'HTTP_ERROR'], [500, 'oops sk-leak', 'HTTP_ERROR'], [302, '', 'HTTP_ERROR'],
    [200, 'not json sk-leak', 'BAD_RESPONSE'], [200, '[]', 'BAD_RESPONSE'], [200, '{"status":"completed"}', 'BAD_RESPONSE'],
    [200, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: 'x' }] }), 'BAD_RESPONSE'],
    [200, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 5 }] }] }), 'BAD_RESPONSE'],
    [200, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] }), 'BAD_RESPONSE'],
    [200, JSON.stringify({ status: 'completed', output: [] }), 'BAD_RESPONSE'],
    [200, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }, { type: 'output_text', text: '{}' }] }] }), 'BAD_RESPONSE'],
    [200, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no sk-leak' }] }] }), 'REFUSED'],
    [200, okBody(COPY, 'incomplete'), 'INCOMPLETE'], [200, okBody(COPY, 'failed'), 'INCOMPLETE'],
  ];
  for (const [status, body, code] of cases) {
    const { t, calls } = transport(status, body);
    const r = await createOpenAiAdGenerator(cfg(t)).generate(prompt);
    assert.deepEqual(r, { kind: 'error', code, called: true }, `${status} ${body.slice(0, 40)}`);
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(r).includes('sk-leak'));
  }
});

test('OA4 deadline: 늦은 headers는 본문 읽기 0·정리, signal abort, 반환 결과 불변', async () => {
  const { t, calls, streams } = transport(200, okBody(), 1100); // abort를 무시하고 1100ms 뒤 반환
  const started = Date.now();
  const r = await createOpenAiAdGenerator(cfg(t, { timeoutMs: 1000 })).generate(prompt);
  assert.deepEqual(r, { kind: 'error', code: 'TIMEOUT', called: true });
  assert.ok(Date.now() - started < 1090);
  assert.equal(calls[0]!.init.signal.aborted, true);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.st.pulls, 0, '마감 뒤 도착한 본문은 읽지 않는다');
  assert.equal(streams[0]!.st.cancelled, true, '본문 정리(cancel)');
  assert.equal(calls.length, 1, '재시도 0');
});

test('OA4b deadline: 읽는 중 멈춘 본문은 취소, 늦은 chunk 뒤 새 읽기 0, 정리 실패·지연이 반환을 막지 않음', async () => {
  for (const opt of [{}, { cancelThrows: true }, { cancelHangs: true }]) {
    const s = stream([enc('{"status":')], { hangAfter: 1, ...opt });
    const t: HttpTransport = async () => ({ status: 200, body: s.body });
    const started = Date.now();
    const r = await createOpenAiAdGenerator(cfg(t, { timeoutMs: 1000 })).generate(prompt);
    assert.deepEqual(r, { kind: 'error', code: 'TIMEOUT', called: true }, JSON.stringify(opt));
    assert.ok(Date.now() - started < 1200, '정리를 기다리지 않음');
    assert.equal(s.st.cancelled, true);
    const pulls = s.st.pulls;
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(s.st.pulls, pulls, '취소 뒤 새 읽기 없음');
  }
  // 마감 직전에 chunk가 오고 그 뒤 마감 → 다음 read를 시작하지 않는다
  let pulls = 0;
  let cancelled = false;
  const slow = new ReadableStream<Uint8Array>({
    async pull(c) {
      pulls++;
      await new Promise((res) => setTimeout(res, 700));
      c.enqueue(enc('{'));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const t2: HttpTransport = async () => ({ status: 200, body: slow });
  assert.deepEqual(await createOpenAiAdGenerator(cfg(t2, { timeoutMs: 1000 })).generate(prompt), { kind: 'error', code: 'TIMEOUT', called: true });
  await new Promise((res) => setTimeout(res, 800));
  assert.equal(cancelled, true);
  assert.ok(pulls <= 2, `마감 뒤 추가 read 없음(pulls=${pulls})`);
});

test('OA5 실제 바이트 상한: 초과 chunk에서 즉시 취소·추가 읽기 0, 정확 경계 통과, Content-Length 미사용, transport 예외', async () => {
  // 1KB chunk를 무한히 주는 스트림 → 상한 1024+α에서 중단
  let pulls = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) { pulls++; c.enqueue(new Uint8Array(1000).fill(32)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const tInf: HttpTransport = async () => ({ status: 200, body: endless, headers: { 'content-length': '10' } } as never);
  assert.deepEqual(await createOpenAiAdGenerator(cfg(tInf, { maxResponseBytes: 2048 })).generate(prompt), { kind: 'error', code: 'TOO_LARGE', called: true });
  assert.equal(cancelled, true);
  assert.equal(pulls, 3, '2048 초과 순간(3번째 chunk)에서 중단');
  // 정확 경계: 본문 바이트 = 상한 → 통과, 상한-1 → TOO_LARGE
  const exact = JSON.stringify({ ...JSON.parse(okBody()), pad: 'x'.repeat(1200) }); // 설정 하한(1024바이트) 이상으로 맞춘 정상 본문
  const n = enc(exact).byteLength;
  const s1 = stream([enc(exact)]);
  assert.equal((await createOpenAiAdGenerator(cfg(async () => ({ status: 200, body: s1.body }), { maxResponseBytes: n })).generate(prompt)).kind, 'ok');
  const s2 = stream([enc(exact)]);
  assert.deepEqual(await createOpenAiAdGenerator(cfg(async () => ({ status: 200, body: s2.body }), { maxResponseBytes: n - 1 })).generate(prompt), { kind: 'error', code: 'TOO_LARGE', called: true });
  // 여러 chunk로 나뉘어도 합계로 판정, 멀티바이트 경계도 정상 디코드
  const bytes = enc(exact);
  const parts = [bytes.slice(0, 7), bytes.slice(7, 100), bytes.slice(100)];
  const s3 = stream(parts);
  assert.deepEqual(await createOpenAiAdGenerator(cfg(async () => ({ status: 200, body: s3.body }))).generate(prompt), { kind: 'ok', data: COPY, called: true });
  // 잘못된 UTF-8·비 Uint8Array chunk·본문 없음
  const s4 = stream([new Uint8Array([0xff, 0xfe])]);
  assert.deepEqual(await createOpenAiAdGenerator(cfg(async () => ({ status: 200, body: s4.body }))).generate(prompt), { kind: 'error', code: 'BAD_RESPONSE', called: true });
  const weird = new ReadableStream({ pull(c) { c.enqueue('문자열 chunk' as unknown as Uint8Array); } }) as ReadableStream<Uint8Array>;
  assert.deepEqual(await createOpenAiAdGenerator(cfg(async () => ({ status: 200, body: weird }))).generate(prompt), { kind: 'error', code: 'BAD_RESPONSE', called: true });
  assert.deepEqual(await createOpenAiAdGenerator(cfg(async () => ({ status: 200, body: null }))).generate(prompt), { kind: 'error', code: 'BAD_RESPONSE', called: true });
  // 오류 응답 본문은 읽지 않고 정리
  const s5 = stream([enc('{"error":"sk-leak"}')]);
  assert.deepEqual(await createOpenAiAdGenerator(cfg(async () => ({ status: 500, body: s5.body }))).generate(prompt), { kind: 'error', code: 'HTTP_ERROR', called: true });
  assert.equal(s5.st.pulls, 0);
  assert.equal(s5.st.cancelled, true);
  const throwing: HttpTransport = async () => { throw new Error('ECONNRESET sk-leak api.openai.com'); };
  const r = await createOpenAiAdGenerator(cfg(throwing)).generate(prompt);
  assert.deepEqual(r, { kind: 'error', code: 'TRANSPORT_ERROR', called: true });
  const errStream = new ReadableStream<Uint8Array>({ pull() { throw new Error('sk-leak read'); } });
  const r2 = await createOpenAiAdGenerator(cfg(async () => ({ status: 200, body: errStream }))).generate(prompt);
  assert.deepEqual(r2, { kind: 'error', code: 'TRANSPORT_ERROR', called: true });
  assert.ok(!JSON.stringify(r2).includes('sk-leak'));
});

test('OA6 끝까지: 가짜 transport → 오케스트레이터 검증(금지 주장 거부, 정상은 미게시 초안)', async () => {
  const { t } = transport(200, okBody({ title: '최저가 인터넷·TV', description: COPY.description }));
  assert.deepEqual(await generateAdCopy({ situationId: 'moving', product: 'internet-tv' }, { generator: createOpenAiAdGenerator(cfg(t)) }),
    { ok: false, error: 'OUTPUT_REJECTED', reason: 'FORBIDDEN', generatorCalled: true });
  const { t: t2 } = transport(200, okBody());
  const r = await generateAdCopy({ situationId: 'moving', product: 'internet-tv' }, { generator: createOpenAiAdGenerator(cfg(t2)) });
  assert.ok(r.ok && r.source === 'model' && r.executionAllowed === false);
  assert.ok(!JSON.stringify(r).includes(KEY) && !JSON.stringify(r).includes('resp_fake'));
  assert.deepEqual(parseResponsesBody(okBody()), { kind: 'ok', data: COPY, called: true });
});
