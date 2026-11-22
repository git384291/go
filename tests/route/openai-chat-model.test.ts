// 상담 AI 실제 모델 어댑터(준비 코드) 시험 — 가짜 transport만. 실제 API 호출 0회. 상담 경로 미연결 확인.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildChatBody, createOpenAiChatModel, MAX_REPLY_CHARS, OPENAI_RESPONSES_URL, parseChatReply, type OpenAiChatModelConfig } from '../../src/server/consult/openAiChatModel';
import { createModel, ModelNotCalledError } from '../../src/server/consult/chatModel';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget } from '../../src/server/consult/chatModel';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const KEY = 'sk-test-' + 'A'.repeat(30);
const ok = (text: string, status = 'completed') => JSON.stringify({ status, output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }] });
function fake(res: { status?: number; text?: string; throws?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: string; redirect: string }[] = [];
  const t: BodyTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: new TextDecoder().decode(init.body), redirect: init.redirect });
    if (res.throws) throw new Error('network ' + KEY);
    return { status: res.status ?? 200, body: new Response(res.text ?? ok('안녕하세요. 승인된 안내입니다.')).body };
  };
  return { t, calls };
}
const cfg = (t: BodyTransport | null, over: Partial<OpenAiChatModelConfig> = {}): OpenAiChatModelConfig => ({ transport: t, apiKey: KEY, model: 'test-model', executionAllowed: true, costPerCallKrw: 5, maxOutputTokens: 200, timeoutMs: 5000, maxResponseBytes: 8192, ...over });
const IN = { system: 'SYS', user: '이름은 *** 요금이 궁금해요', approved: '월 11,111원' };
const sig = () => new AbortController().signal;

test('OC1 설정 누락·실행 허용 아님·잘못된 값: 전송 0회, ModelNotCalledError(예약 취소 대상)', async () => {
  for (const over of [{ executionAllowed: 'true' }, { executionAllowed: false }, { apiKey: 'short' }, { model: 'Bad Model' }, { costPerCallKrw: 0 }, { maxOutputTokens: 5000 }, { timeoutMs: 60000 }]) {
    const f = fake();
    await assert.rejects(createOpenAiChatModel(cfg(f.t, over as never)).generate(IN, sig()), ModelNotCalledError, JSON.stringify(over));
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(createOpenAiChatModel(null).generate(IN, sig()), ModelNotCalledError);
  const ac = new AbortController(); ac.abort();
  const f = fake(); await assert.rejects(createOpenAiChatModel(cfg(f.t)).generate(IN, ac.signal), ModelNotCalledError); assert.equal(f.calls.length, 0);
});
test('OC2 요청 계약: 고정 URL·Bearer·store false·tools 없음·redirect error, 1회, 본문은 가린 글+승인 안내문만', async () => {
  const f = fake();
  const out = await createOpenAiChatModel(cfg(f.t)).generate(IN, sig());
  assert.equal(out, '안녕하세요. 승인된 안내입니다.');
  assert.equal(f.calls.length, 1);
  const c = f.calls[0]!;
  assert.deepEqual([c.url, c.redirect, c.headers.Authorization], [OPENAI_RESPONSES_URL, 'error', `Bearer ${KEY}`]);
  const b = JSON.parse(c.body);
  assert.deepEqual(Object.keys(b).sort(), ['input', 'instructions', 'max_output_tokens', 'model', 'store']);
  assert.equal(b.store, false);
  assert.equal(c.body, buildChatBody('test-model', IN, 200));
  assert.ok(b.input.includes('월 11,111원') && b.input.includes('***'));
});
test('OC3 응답 불신: 거절·미완료·형식 이상·텍스트 2개·길이 초과·HTTP 오류·429·전송 오류는 모두 오류(본문·키 반사 없음)', async () => {
  assert.throws(() => parseChatReply(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'x' }] }] })), /REFUSED/);
  assert.throws(() => parseChatReply(ok('a', 'incomplete')), /INCOMPLETE/);
  assert.throws(() => parseChatReply('not json'), /BAD_RESPONSE/);
  assert.throws(() => parseChatReply(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] })), /BAD_RESPONSE/);
  assert.throws(() => parseChatReply(ok('가'.repeat(MAX_REPLY_CHARS + 1))), /BAD_RESPONSE/);
  for (const [r, re] of [[{ status: 500, text: 'secret ' + KEY }, /HTTP_ERROR/], [{ status: 429 }, /HTTP_RATE_LIMITED/], [{ throws: true }, /TRANSPORT_ERROR/]] as const) {
    const e = await createOpenAiChatModel(cfg(fake(r).t)).generate(IN, sig()).catch((x: Error) => x);
    assert.ok(e instanceof Error && re.test(e.message) && !e.message.includes(KEY), String(e));
  }
  const big = await createOpenAiChatModel(cfg(fake({ text: 'x'.repeat(9000) }).t)).generate(IN, sig()).catch((x: Error) => x);
  assert.ok(big instanceof Error && /TOO_LARGE/.test(big.message));
});
test('OC4 상담 흐름에 넣어도 가드 유지: 승인 밖 금액을 말하면 승인 안내문으로 대체, 모델 오류는 안전 안내문', async () => {
  const rec = { provider: () => [], supplierId: 'supplier-a', budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' }) };
  const evil = createOpenAiChatModel(cfg(fake({ text: ok('월 9,900원에 해 드려요') }).t));
  const r = await answerChat({ ...rec, model: evil } as never, { message: '요금이 궁금해요', carrier: 'carrier-x', productId: 'p', regionCode: 'r' }, new Date());
  assert.ok(r.ok && r.source === 'fallback' && !r.text.includes('9,900'));
  const broken = createOpenAiChatModel(cfg(fake({ status: 500 }).t));
  const r2 = await answerChat({ ...rec, model: broken } as never, { message: '요금이 궁금해요', carrier: 'carrier-x', productId: 'p', regionCode: 'r' }, new Date());
  assert.ok(r2.ok && r2.source === 'fallback');
});
test('OC5 미연결: createModel은 mock 외에 모델을 만들지 않고, 상담 경로·라우트가 이 어댑터를 가져다 쓰지 않음', () => {
  for (const v of ['openai', 'gpt', 'real', '']) assert.equal(createModel({ CONSULT_AI_MODEL: v }), null);
  for (const f of ['src/server/consult/chatModel.ts', 'src/server/consult/chatAnswer.ts', 'src/server/consult/chatHandler.ts', 'src/app/api/consult/chat/route.ts']) {
    assert.ok(!readFileSync(f, 'utf8').includes('openAiChatModel'), f);
  }
});
