// PM 11/24 ④ 실제 AI 모델 연동 — 연결 경로·usage 기준 확정·실패 시 이중 차감/무한 재시도 없음·키 비노출. 가짜 전송만(실제 호출 0회).
// 실제 API 호출 시험은 tests/live/openai-consult.live.test.ts(CI secret이 있을 때만).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultModelFromEnv, parseUsage } from '../../src/server/consult/openAiChatModel';
import { createAiBudget, grantBudgetPermit, mockModel, ModelNotCalledError, type AiBudget, type ChatModel } from '../../src/server/consult/chatModel';
import { withRecovery } from '../../src/server/consult/modelRecovery';
import { answerChat, type AiFailureEvent } from '../../src/server/consult/chatAnswer';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const KEY = 'sk-test-' + 'B'.repeat(30);
const EP = 'https://model.example.test/v1/responses'; // 가짜 주소
const NOW = new Date('2026-11-23T12:00:00+09:00');
const K = <T,>(value: T) => ({ known: true as const, value });
const rec = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved', confirmedAt: '2026-11-23T09:00:00+09:00', validFrom: '2026-11-23T00:00:00+09:00', validUntil: K('2026-11-24T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36), equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([]), regionScope: K('nationwide'),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
};
const body = (usage: unknown) => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '문의 주셔서 감사합니다. 담당자가 확인해 안내드리겠습니다.' }] }], ...(usage === undefined ? {} : { usage }) });
const USAGE = { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 } }; // (1,000×360 + 100×2,160)/100만 = 0.576 → 1원

function script(steps: ({ status: number; text?: string } | 'throw')[]) {
  const calls: { body: string }[] = [];
  const t: BodyTransport = async (_url, init) => {
    calls.push({ body: new TextDecoder().decode(init.body) });
    const s = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (s === 'throw') throw new Error('net ' + KEY);
    return { status: s.status, body: new Response(s.text ?? '{}').body };
  };
  return { t, calls };
}
const ON = { CONSULT_AI_MODEL: 'gpt-5.6-luna', CONSULT_AI_ENDPOINT: EP, CONSULT_AI_API_KEY: KEY, CONSULT_AI_EXECUTION: 'allow' };
const live = (t: BodyTransport): ChatModel => consultModelFromEnv(ON, t)!; // 라우트와 같은 모델 선택(1회 예약 2원)
function ledger() {
  const ev: string[] = []; const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' });
  const budget: AiBudget = { async reserve(c, ctx) { ev.push(`reserve:${c}`); const r = await inner.reserve(c, ctx); if (!r) return null;
    return { async confirm(a) { ev.push(`confirm:${a}`); return r.confirm(a); }, async cancel() { ev.push('cancel'); return r.cancel(); }, async uncertain() { ev.push('uncertain'); return r.uncertain!(); } }; } };
  return { ev, budget };
}
const ask = (model: ReturnType<typeof withRecovery>, budget: AiBudget, log: AiFailureEvent[] = [], message = '제 번호 010-1234-5678 인데 요금이 궁금해요') =>
  answerChat({ provider: () => [rec] as never, supplierId: 'supplier-a', model, budget, failureLog: (e) => log.push(e) }, { message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' }, NOW);

test('LC1 usage 파싱: 입력·캐시·출력 토큰, 형식 이상·음수·캐시 > 입력은 null(사용량 모름)', () => {
  assert.deepEqual(parseUsage(body(USAGE)), { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 });
  assert.deepEqual(parseUsage(body({ input_tokens: 9, output_tokens: 1, input_tokens_details: { cached_tokens: 4 } })), { inputTokens: 9, outputTokens: 1, cachedInputTokens: 4 });
  assert.deepEqual(parseUsage(body({ input_tokens: 10, output_tokens: 2 })), { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
  for (const u of [undefined, null, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 6 } }, { input_tokens: '5', output_tokens: 1 }]) assert.equal(parseUsage(body(u)), null, JSON.stringify(u));
  assert.equal(parseUsage('not json'), null);
});

test('LC2 성공: 예약 1회 → 호출 1회 → usage 기준 확정(예약 이하), 고객 연락처는 가린 뒤에만 전송, 키는 응답에 없음', async () => {
  const s = script([{ status: 200, text: body(USAGE) }]);
  const { ev, budget } = ledger();
  const model = withRecovery(live(s.t));
  const r = await ask(model, budget);
  assert.ok(r.ok && r.source === 'model');
  // usage 1원. 예약 = 1회 2원 × 2회(재시도 상한) = 4원
  assert.deepEqual(ev, ['reserve:4', 'confirm:1']);
  assert.equal(s.calls.length, 1);
  assert.ok(!s.calls[0]!.body.includes('010-1234-5678') && !s.calls[0]!.body.includes(KEY), '연락처 가림, 키는 본문에 없음(헤더로만)');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('LC3 5xx 뒤 성공: 재시도 1회만, 확정 = 실패 전송 1회 예약분 + 성공 usage(이중 차감·예약 초과 없음)', async () => {
  const s = script([{ status: 503 }, { status: 200, text: body(USAGE) }]);
  const { ev, budget } = ledger();
  const r = await ask(withRecovery(live(s.t), { baseDelayMs: 1 }), budget);
  assert.ok(r.ok && r.source === 'model');
  assert.deepEqual(ev, ['reserve:4', 'confirm:3'], '실패 2원(과금 여부 모름 → 보수) + 성공 usage 1원');
  assert.equal(s.calls.length, 2);
});

test('LC4 429·5xx 계속: 전송은 재시도 상한(2회)에서 멈춤, 예약 1회·정산 1회, 확정은 예약 이하, 실패 기록에 키·고객 글 없음', async () => {
  for (const status of [429, 500, 502]) {
    const s = script([{ status }]);
    const { ev, budget } = ledger(); const log: AiFailureEvent[] = [];
    const r = await ask(withRecovery(live(s.t), { baseDelayMs: 1 }), budget, log);
    assert.ok(r.ok && r.source === 'fallback', String(status));
    assert.equal(s.calls.length, 2, `${status}: 무한 재시도 없음`);
    assert.equal(ev.filter((e) => e.startsWith('reserve')).length, 1);
    assert.equal(ev.filter((e) => /^(confirm|cancel|uncertain)/.test(e)).length, 1, `${status}: 정산 1회(이중 차감 없음)`);
    assert.ok(!JSON.stringify(log).includes(KEY) && !JSON.stringify(log).includes('010'), String(status));
  }
});

test('LC5 usage 없는 성공 응답: 사용량 모름 → 1회 예약분으로 보수 확정(0원 확정 없음)', async () => {
  const s = script([{ status: 200, text: body(undefined) }]);
  const { ev, budget } = ledger();
  await ask(withRecovery(live(s.t)), budget);
  assert.deepEqual(ev, ['reserve:4', 'confirm:2']);
});

test('LC6 모델 선택: mock은 운영 배포 금지, 실제 모델은 키·주소·실행 허용(allow)이 모두 있어야 전송, 키는 모델 객체·오류에 없음', async () => {
  assert.equal(consultModelFromEnv({ CONSULT_AI_MODEL: 'mock', VERCEL_ENV: 'production' }, null), null);
  assert.equal(consultModelFromEnv({ CONSULT_AI_MODEL: 'mock', VERCEL_ENV: 'preview' }, null), mockModel);
  const s = script([{ status: 200, text: body(USAGE) }]);
  assert.ok(!JSON.stringify(live(s.t)).includes(KEY));
  for (const over of [{ CONSULT_AI_EXECUTION: 'true' }, { CONSULT_AI_API_KEY: undefined }, { CONSULT_AI_ENDPOINT: undefined }]) {
    const m = consultModelFromEnv({ ...ON, ...over }, s.t)!;
    const meter = { sent: 0 }; grantBudgetPermit(meter);
    await assert.rejects(m.generate({ system: 's', user: 'u', approved: 'a' }, new AbortController().signal, meter), (e: unknown) => e instanceof ModelNotCalledError && !String(e).includes(KEY), JSON.stringify(over));
  }
  assert.equal(s.calls.length, 0, '하나라도 빠지면 전송 0회');
});
