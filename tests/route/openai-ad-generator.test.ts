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
const transport = (status: number, body: string | (() => Promise<string>), delayMs = 0) => {
  const calls: Call[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { status, text: async () => (typeof body === 'function' ? body() : body) };
  };
  return { t, calls };
};
const cfg = (t: HttpTransport | null, over: Partial<OpenAiAdGeneratorConfig> = {}): OpenAiAdGeneratorConfig => ({
  transport: t, apiKey: KEY, model: 'fake-model-1', executionAllowed: true, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192, ...over,
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

test('OA4 deadline: 늦은 응답은 TIMEOUT, signal abort, 늦게 온 결과 미사용', async () => {
  const { t, calls } = transport(200, okBody(), 1500);
  const started = Date.now();
  const r = await createOpenAiAdGenerator(cfg(t, { timeoutMs: 1000 })).generate(prompt);
  assert.deepEqual(r, { kind: 'error', code: 'TIMEOUT', called: true });
  assert.ok(Date.now() - started < 1450);
  assert.equal(calls[0]!.init.signal.aborted, true);
  await new Promise((res) => setTimeout(res, 600)); // 늦은 응답이 와도 이미 반환된 결과는 바뀌지 않는다
  assert.equal(calls.length, 1);
});

test('OA5 응답 크기 상한·transport 예외 → 고정 코드', async () => {
  const big = okBody({ title: COPY.title, description: COPY.description + ' '.repeat(10) }) + ' '.repeat(9000);
  const { t } = transport(200, big);
  assert.deepEqual(await createOpenAiAdGenerator(cfg(t)).generate(prompt), { kind: 'error', code: 'TOO_LARGE', called: true });
  const throwing: HttpTransport = async () => { throw new Error('ECONNRESET sk-leak api.openai.com'); };
  const r = await createOpenAiAdGenerator(cfg(throwing)).generate(prompt);
  assert.deepEqual(r, { kind: 'error', code: 'TRANSPORT_ERROR', called: true });
  const badText: HttpTransport = async () => ({ status: 200, text: async () => { throw new Error('sk-leak'); } });
  assert.deepEqual(await createOpenAiAdGenerator(cfg(badText)).generate(prompt), { kind: 'error', code: 'TRANSPORT_ERROR', called: true });
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
