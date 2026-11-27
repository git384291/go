// Gemini 무료 등급 어댑터 시험 — 가짜 전송·가상 문구만. 실제 API 호출·과금 없음(PM 11/26 승인 범위)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { grantBudgetPermit, ModelNotCalledError, type ModelInput } from '../../src/server/consult/chatModel';
import { buildGeminiBody, createGeminiChatModel, freeTierEnvAllowed, geminiFreeModelFromEnv, parseGeminiReply, parseGeminiUsage, GEMINI_FREE_UNIT_KRW } from '../../src/server/consult/geminiChatModel';
import { geminiEndpointFor, geminiFetchTransport } from '../../src/server/ai/geminiTransport';
import { consultModelFromEnv } from '../../src/server/consult/openAiChatModel';
import { ModelCallError } from '../../src/server/consult/modelRecovery';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const MODEL = 'gemini-test-flash';
const KEY = 'AIza_test_key_0123456789_abcdefgh'; // 가짜 키(형식만)
const EP = geminiEndpointFor(MODEL)!;
const input: ModelInput = { system: '승인된 안내문 안의 금액 외에는 말하지 않는다.', user: '설치 며칠 걸려요?', approved: '설치는 접수 후 안내드립니다.' };
const enc = new TextEncoder();
const stream = (s: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
const okBody = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 }, ...extra });
type Seen = { url: string; headers: Record<string, string>; body: string };
function fake(status: number, body: string, seen: Seen[] = []): BodyTransport {
  return async (url, init) => { seen.push({ url, headers: init.headers, body: new TextDecoder().decode(init.body) }); return { status, body: stream(body) }; };
}
const cfg = (t: BodyTransport | null, over: Record<string, unknown> = {}) => ({
  transport: t, endpoint: EP, apiKey: KEY, model: MODEL, executionAllowed: true,
  maxOutputTokens: 512, timeoutMs: 7000, maxResponseBytes: 32768, maxInputTokens: 4000, ...over });
const permit = () => { const m = { sent: 0 } as { sent: number; usageKrw?: number; usageCount?: number }; grantBudgetPermit(m); return m; };
const ac = () => new AbortController().signal;

test('GM1 정상 호출: 헤더 키·주소에 키 없음·본문에 키 없음·답변·사용량 1원 단위 정산', async () => {
  const seen: Seen[] = []; const meter = permit();
  const m = createGeminiChatModel(cfg(fake(200, okBody('설치 일정은 접수 후 안내드립니다.'), seen)));
  assert.equal(await m.generate(input, ac(), meter), '설치 일정은 접수 후 안내드립니다.');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, EP);
  assert.ok(!seen[0]!.url.includes(KEY) && !seen[0]!.url.includes('?'), '주소에 키·쿼리 없음');
  assert.equal(seen[0]!.headers['x-goog-api-key'], KEY);
  assert.ok(!('Authorization' in seen[0]!.headers));
  assert.ok(!seen[0]!.body.includes(KEY), '본문에 키 없음');
  assert.equal(meter.usageKrw, GEMINI_FREE_UNIT_KRW); assert.equal(meter.usageCount, 1);
  assert.equal(m.name, 'gemini-free'); assert.equal(m.costPerCallKrw, 1);
});

test('GM2 전송 0회 조건: 허가 없음·설정 누락·실행 미허용·잘못된 키/주소/모델·개인정보·입력 과대·중단', async () => {
  const seen: Seen[] = []; const t = fake(200, okBody('x'), seen);
  const bad = async (c: ReturnType<typeof cfg> | null, inp: ModelInput = input, meter: { sent: number } | null = permit(), sig: AbortSignal = ac()) => {
    await assert.rejects(createGeminiChatModel(c).generate(inp, sig, meter ?? undefined), (e) => e instanceof ModelNotCalledError);
  };
  await bad(null);
  await bad(cfg(t), input, { sent: 0 });            // 허가 없는 meter
  await bad(cfg(t), input, null);                   // meter 없음
  await bad(cfg(t, { executionAllowed: 'true' }));   // 정확히 true만
  await bad(cfg(t, { apiKey: 'short' }));
  await bad(cfg(t, { apiKey: null }));
  await bad(cfg(null));
  await bad(cfg(t, { endpoint: 'https://example.com/v1beta/models/gemini-test-flash:generateContent' }));
  await bad(cfg(t, { endpoint: EP + '?key=' + KEY }));
  await bad(cfg(t, { model: 'gpt-5.6-luna' }));
  await bad(cfg(t, { maxInputTokens: 64 }));        // 입력 과대(본문 > 64바이트)
  await bad(cfg(t), { ...input, user: '제 전화번호는 010-1234-5678 입니다' }); // 개인정보 모양
  const ctl = new AbortController(); ctl.abort();
  await bad(cfg(t), input, permit(), ctl.signal);
  assert.equal(seen.length, 0, '위 모든 경우 전송 0회');
});

test('GM3 실패 분류: 429·5xx·4xx는 재시도 가능 여부 구분, 형식 이상·차단·미완료는 response', async () => {
  const run = (status: number, body: string) => createGeminiChatModel(cfg(fake(status, body))).generate(input, ac(), permit());
  await assert.rejects(run(429, '{}'), (e) => e instanceof ModelCallError && e.kind === 'rate_limited');
  await assert.rejects(run(503, '{}'), (e) => e instanceof ModelCallError && e.kind === 'server');
  await assert.rejects(run(400, '{"error":"secret-body-not-reflected"}'), (e) => e instanceof ModelCallError && e.kind === 'client' && !String(e.message).includes('secret-body'));
  await assert.rejects(run(200, 'not json'), (e) => e instanceof ModelCallError && e.kind === 'response');
  await assert.rejects(run(200, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })), (e) => e instanceof ModelCallError && e.message === 'REFUSED');
});

test('GM4 응답 해석: 미완료·여러 후보·함수 호출·긴 답·빈 답은 오류, 생각 요약은 제외', () => {
  assert.equal(parseGeminiReply(okBody('  안내입니다  ')), '안내입니다');
  assert.throws(() => parseGeminiReply(JSON.stringify({ candidates: [{ content: { parts: [{ text: '잘림' }] }, finishReason: 'MAX_TOKENS' }] })), /INCOMPLETE/);
  assert.throws(() => parseGeminiReply(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'SAFETY' }] })), /REFUSED/);
  assert.throws(() => parseGeminiReply(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'STOP' }, { content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }] })), /BAD_RESPONSE/);
  assert.throws(() => parseGeminiReply(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'x', args: {} } }] }, finishReason: 'STOP' }] })), /BAD_RESPONSE/);
  assert.throws(() => parseGeminiReply(okBody('가'.repeat(601))), /BAD_RESPONSE/);
  assert.throws(() => parseGeminiReply(okBody('   ')), /BAD_RESPONSE/);
  assert.equal(parseGeminiReply(JSON.stringify({ candidates: [{ content: { parts: [{ text: '생각', thought: true }, { text: '답' }] }, finishReason: 'STOP' }] })), '답');
  assert.deepEqual(parseGeminiUsage(okBody('x')), { inputTokens: 120, outputTokens: 30 });
  assert.equal(parseGeminiUsage('{"usageMetadata":{"promptTokenCount":-1,"candidatesTokenCount":1}}'), null);
  assert.equal(parseGeminiUsage('{}'), null);
});

test('GM5 요청 본문: 도구·검색·코드 실행 없음, 후보 1개, 승인 안내문과 가린 문의만', () => {
  const b = JSON.parse(buildGeminiBody(input, 512));
  assert.deepEqual(Object.keys(b).sort(), ['contents', 'generationConfig', 'systemInstruction']);
  assert.equal(b.generationConfig.candidateCount, 1); assert.equal(b.generationConfig.maxOutputTokens, 512);
  assert.ok(b.contents[0].parts[0].text.includes(input.approved) && b.contents[0].parts[0].text.includes(input.user));
  assert.ok(!('tools' in b) && !('toolConfig' in b) && !('cachedContent' in b));
});

test('GM6 환경 선택: 제공자·환경 허용 목록·모델 형식이 모두 맞을 때만, 운영·환경 불명은 null', () => {
  const base = { CONSULT_AI_PROVIDER: 'gemini-free', CONSULT_AI_MODEL: MODEL, CONSULT_AI_API_KEY: KEY, CONSULT_AI_EXECUTION: 'allow' };
  const t = fake(200, okBody('x'));
  assert.equal(geminiFreeModelFromEnv({ ...base, VERCEL_ENV: 'preview' }, t)?.name, 'gemini-free');
  assert.equal(geminiFreeModelFromEnv({ ...base, APP_ENV: 'dev' }, t)?.name, 'gemini-free');
  assert.equal(geminiFreeModelFromEnv({ ...base, NODE_ENV: 'test' }, t)?.name, 'gemini-free');
  assert.equal(geminiFreeModelFromEnv({ ...base, VERCEL_ENV: 'production' }, t), null, 'Vercel 운영 금지');
  assert.equal(geminiFreeModelFromEnv({ ...base, APP_ENV: 'production', NODE_ENV: 'test' }, t), null, '다른 호스팅 운영 금지');
  assert.equal(geminiFreeModelFromEnv({ ...base, NODE_ENV: 'production' }, t), null, '환경 불명(호스팅 변경 시)도 금지');
  assert.equal(geminiFreeModelFromEnv({ ...base, VERCEL_ENV: 'preview', CONSULT_AI_PROVIDER: 'openai' }, t), null);
  assert.equal(geminiFreeModelFromEnv({ ...base, VERCEL_ENV: 'preview', CONSULT_AI_MODEL: 'gpt-5.6-luna' }, t), null);
  assert.equal(geminiFreeModelFromEnv({ ...base, VERCEL_ENV: 'preview', CONSULT_AI_MODEL: 'gemini-' }, t), null);
  assert.equal(freeTierEnvAllowed({}), false);
  // 실행 허용이 없으면 객체는 있어도 전송 0회
  const m = geminiFreeModelFromEnv({ ...base, VERCEL_ENV: 'preview', CONSULT_AI_EXECUTION: 'deny' }, t)!;
  assert.ok(m);
});

test('GM7 실행 허용 없음이면 전송 0회, 기존 OpenAI 경로는 그대로(가격표 밖 gemini 이름은 호출 금지)', async () => {
  const seen: Seen[] = [];
  const m = geminiFreeModelFromEnv({ CONSULT_AI_PROVIDER: 'gemini-free', CONSULT_AI_MODEL: MODEL, CONSULT_AI_API_KEY: KEY, CONSULT_AI_EXECUTION: 'deny', VERCEL_ENV: 'preview' }, fake(200, okBody('x'), seen))!;
  await assert.rejects(m.generate(input, ac(), permit()), (e) => e instanceof ModelNotCalledError);
  assert.equal(seen.length, 0);
  assert.equal(consultModelFromEnv({ CONSULT_AI_MODEL: MODEL, CONSULT_AI_API_KEY: KEY, CONSULT_AI_EXECUTION: 'allow' }, fake(200, okBody('x'), seen)), null, 'OpenAI 경로는 가격표 밖 이름을 거부');
  assert.equal(consultModelFromEnv({ CONSULT_AI_MODEL: 'mock', VERCEL_ENV: 'production' }, null), null, '기존 mock 운영 금지 유지');
});

test('GM8 전송 허용 주소: Google generateContent 형식 1곳만, 그 밖은 fetch 전에 거부', async () => {
  const noop = new AbortController().signal;
  for (const u of ['https://api.openai.com/v1/responses', 'http://generativelanguage.googleapis.com/v1beta/models/gemini-x1:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-x1:generateContent?key=abc', 'https://generativelanguage.googleapis.com/v1beta/models/gpt-4:generateContent',
    'https://generativelanguage.googleapis.com.evil.com/v1beta/models/gemini-x1:generateContent', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x1:streamGenerateContent']) {
    await assert.rejects(geminiFetchTransport(u, { method: 'POST', headers: {}, signal: noop, redirect: 'error' }), /DESTINATION_NOT_ALLOWED/, u);
  }
  assert.equal(geminiEndpointFor('gemini-x1'), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x1:generateContent');
  assert.equal(geminiEndpointFor('../x'), null); assert.equal(geminiEndpointFor('gpt-4'), null);
});

test('GM9 정적: 키·fetch·허가 부여 위치 제한(상담 폴더 fetch 금지, 키는 헤더로만, 허가는 어댑터가 붙이지 않음)', () => {
  const a = readFileSync('src/server/consult/geminiChatModel.ts', 'utf8');
  const t = readFileSync('src/server/ai/geminiTransport.ts', 'utf8');
  assert.ok(!/fetch\(/.test(a), '상담 폴더에 fetch 없음');
  assert.ok(!/grantBudgetPermit\(/.test(a), '허가는 chatAnswer만 붙인다');
  assert.ok(!/\?key=|key=\$\{/.test(a + t), '키를 주소에 넣지 않음');
  assert.ok(!/console\.|process\.env/.test(t), '전송 파일은 로그·환경변수 없음');
});
