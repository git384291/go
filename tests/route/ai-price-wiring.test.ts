// PM 11/24 후속: 공식 확인 가격표를 상담 경로에 연결(consultModelFromEnv) — 단가 불확실 차단·비용 한도 초과 방지. 가짜 transport만, 실제 AI 호출 0회.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultModelFromEnv, CONSULT_CALL_LIMITS } from '../../src/server/consult/openAiChatModel';
import { createAiBudget, mockModel, type AiBudget, type ChatModel } from '../../src/server/consult/chatModel';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { withRecovery } from '../../src/server/consult/modelRecovery';
import { estimateMaxKrw, priceFor, type ModelPrice } from '../../src/server/ai/costModel';
import { VERIFIED_USD_PRICES, verifiedKrwPrices } from '../../src/server/ai/verifiedPrices';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const ON = { CONSULT_AI_MODEL: 'gpt-5.6-luna', CONSULT_AI_ENDPOINT: 'https://model.example.test/v1/responses', CONSULT_AI_API_KEY: 'sk-test-' + 'A'.repeat(30), CONSULT_AI_EXECUTION: 'allow' };
const OK_BODY = JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '문의 주셔서 감사합니다. 현재 확인된 안내입니다.' }] }] });
function fake(mode: 'ok' | 'http500' | 'hang' = 'ok') {
  const f = { calls: 0, t: null as unknown as BodyTransport };
  f.t = async () => {
    f.calls++;
    if (mode === 'hang') return new Promise<never>(() => {});
    return { status: mode === 'ok' ? 200 : 500, body: new Response(mode === 'ok' ? OK_BODY : '{}').body };
  };
  return f;
}
/** 메모리 예산 + 정산 기록(확정 금액은 예산과 같은 규칙: 1~1,000원 정수, 불확실 = 예약 전액) */
function tracked(limit: number) {
  const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: String(limit) });
  const log = { holds: 0, denied: 0, spent: 0, cancels: 0, uncertain: 0 };
  const budget: AiBudget = {
    async reserve(c, ctx) {
      const r = await inner.reserve(c, ctx);
      if (!r) { log.denied++; return null; }
      log.holds++;
      return {
        async confirm(a) { log.spent += Math.max(1, Math.min(c, Math.trunc(a))); await r.confirm(a); },
        async cancel() { log.cancels++; await r.cancel(); },
        async uncertain() { log.uncertain++; log.spent += c; await r.uncertain!(); },
      };
    },
  };
  return { budget, log };
}
const K = <T,>(value: T) => ({ known: true as const, value });
const NOW = new Date('2026-11-23T12:00:00+09:00');
const rec = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved', confirmedAt: '2026-11-23T09:00:00+09:00', validFrom: '2026-11-23T00:00:00+09:00', validUntil: K('2026-11-24T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36), equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([]), regionScope: K('nationwide'),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
};
const ask = (model: ChatModel | null, budget: AiBudget) => answerChat({ provider: () => [rec], supplierId: 'supplier-a', model, budget, failureLog: () => {} } as never,
  { message: '요금이 궁금해요', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' }, NOW);
const fast = (m: ChatModel | null) => withRecovery(m!, { sleep: async () => {}, attemptMs: 50, totalMs: 300, baseDelayMs: 0, maxDelayMs: 0, log: () => {} });

test('PW1 모델 ID·단가 연결: gpt-5.6-luna 공식 기록 → 1회 예약 3원(가격표 계산, 환경변수 비용 없음, PM 11/24 A안 출력 512), 재시도 2회 포함 6원, 같은 설정 = 같은 객체', () => {
  const f = fake();
  const m = consultModelFromEnv(ON, f.t)!;
  assert.equal(m.name, 'openai');
  const p = priceFor(verifiedKrwPrices(), 'gpt-5.6-luna')!;
  assert.equal(m.costPerCallKrw, estimateMaxKrw(p, CONSULT_CALL_LIMITS.maxInputTokens, CONSULT_CALL_LIMITS.maxOutputTokens));
  assert.equal(m.costPerCallKrw, 3);
  assert.equal(consultModelFromEnv({ ...ON, CONSULT_AI_COST_PER_CALL_KRW: '0' }, f.t)!.costPerCallKrw, 3, '비용은 환경변수로 바꿀 수 없다');
  assert.equal(consultModelFromEnv(ON, f.t), consultModelFromEnv(ON, f.t), '차단기 상태 유지');
  const r = withRecovery(m);
  assert.deepEqual([r.costPerCallKrw, r.attemptCostKrw], [6, 3]);
  assert.equal(consultModelFromEnv({ CONSULT_AI_MODEL: 'mock' }, f.t), mockModel);
  assert.equal(VERIFIED_USD_PRICES[0]!.model, 'gpt-5.6-luna');
  assert.equal(f.calls, 0);
});

test('PW2 단가 불확실 = 모델 없음(호출 0회): 기록 없는 ID·대소문자·날짜 붙은 ID·빈 값, 가격표 이상(USD·중복·빈 표·캐시>입력·출처 없음)', async () => {
  const f = fake();
  for (const name of ['gpt-5.6-terra', 'GPT-5.6-LUNA', 'gpt-5.6-luna-2026-01-01', 'gpt-5.6-luna ', 'openai', '', undefined]) {
    assert.equal(consultModelFromEnv({ ...ON, CONSULT_AI_MODEL: name }, f.t), null, String(name));
  }
  const p = priceFor(verifiedKrwPrices(), 'gpt-5.6-luna')!;
  const bad: (readonly ModelPrice[])[] = [[], [{ ...p, currency: 'USD' }], [p, p], [{ ...p, cachedInputKrwPerMTok: p.inputKrwPerMTok + 1 }], [{ ...p, outputKrwPerMTok: -1 }],
    verifiedKrwPrices([{ ...VERIFIED_USD_PRICES[0]!, sourceUrl: '' }]), verifiedKrwPrices([{ ...VERIFIED_USD_PRICES[0]!, verifiedOn: '' }])];
  for (const table of bad) assert.equal(consultModelFromEnv(ON, f.t, table), null, JSON.stringify(table));
  const { budget, log } = tracked(1000);
  const r2 = await ask(consultModelFromEnv({ ...ON, CONSULT_AI_MODEL: 'gpt-5.6-terra' }, f.t), budget);
  assert.ok(r2.ok && r2.source === 'fallback');
  assert.equal(f.calls, 0);
  assert.equal(log.spent, 0);
});

test('PW3 라우트와 같은 연결(transport null)·실행 허용 아님·키 없음: 설정을 다 켜도 전송 0회, 예약 취소(0원), 안전 안내문', async () => {
  const f = fake();
  for (const [env, t] of [[ON, null], [{ ...ON, CONSULT_AI_EXECUTION: 'true' }, f.t], [{ ...ON, CONSULT_AI_API_KEY: undefined }, f.t], [{ ...ON, CONSULT_AI_ENDPOINT: 'http://model.example.test/v1/responses' }, f.t]] as const) {
    const { budget, log } = tracked(1000);
    const r = await ask(fast(consultModelFromEnv(env, t)), budget);
    assert.ok(r.ok && r.source === 'fallback', JSON.stringify(env));
    assert.equal(log.spent, 0);
    assert.equal(log.cancels, log.holds);
  }
  assert.equal(f.calls, 0);
});

test('PW4 비용 한도 초과 방지(정상 응답, usage 없음 → 1회분 보수 확정): 한도 10원 → 예약 6원·확정 3원씩, 2회 호출 후 거부, 사용 6원 ≤ 10원, 거부 뒤 전송 0회', async () => {
  const f = fake('ok');
  const { budget, log } = tracked(10);
  const m = fast(consultModelFromEnv(ON, f.t));
  for (let i = 0; i < 20; i++) await ask(m, budget);
  assert.equal(f.calls, 2);
  assert.equal(log.spent, 6);
  assert.ok(log.spent <= 10);
  assert.equal(log.denied, 18);
});

test('PW5 비용 한도 초과 방지(장애 500): 재시도 포함 예약 6원 = 실제 전송 2회 × 3원, 한도 10원에서 1요청 뒤 거부, 사용 6원 ≤ 10원', async () => {
  const f = fake('http500');
  const { budget, log } = tracked(10);
  const m = fast(consultModelFromEnv(ON, f.t));
  for (let i = 0; i < 10; i++) { const r = await ask(m, budget); assert.ok(r.ok && r.source === 'fallback'); }
  assert.equal(f.calls, 2);
  assert.equal(log.spent, 6);
  assert.ok(log.spent <= 10);
});

test('PW6 비용 한도 초과 방지(시간 초과): 과금 불확실 = 예약 전액(6원)으로 세고, 한도 10원을 넘기지 않는다', async () => {
  const f = fake('hang');
  const { budget, log } = tracked(10);
  const m = fast(consultModelFromEnv(ON, f.t));
  for (let i = 0; i < 6; i++) await ask(m, budget);
  assert.ok(log.spent <= 10, String(log.spent));
  assert.equal(log.spent, 6 * log.holds);
  assert.ok(log.uncertain >= 1 && log.denied >= 1);
  assert.ok(f.calls <= 2 * log.holds);
});

test('PW7 PM 하드 한도 대비(계산 확인, PM 11/24 A안): 1요청 최대 6원 → 사용자 하루 300원 = 최대 50요청, 전체 하루 3,000원 = 최대 500요청, 월 50,000원 = 최대 8,333요청', () => {
  const r = withRecovery(consultModelFromEnv(ON, fake().t)!);
  assert.deepEqual([300, 3000, 50000].map((l) => Math.floor(l / r.costPerCallKrw)), [50, 500, 8333]);
});
