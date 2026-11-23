// P0 AI 사용량·비용 하드 한도 Mock 검증 (TEST-01~14) — 0026 보강 반영. 가짜 transport만 사용: 실제 AI API 호출 0회, 운영 DB·고객정보 미사용.
// - 앱 계층(answerChat·비용 게이트·어댑터·복구 래퍼·가격 계산)은 여기서 검증한다.
// - DB 계층(일·사용자·동시 한도, 긴급 차단, 멱등, 불확실 정산·조정, KST 일 키, 권한)은 db/tests/99_ai_cost_hardlimit.sql(H*)과
//   scripts/ai-cost-db-concurrency.sh(D*, 서로 다른 DB 세션 동시 실행)에서 검증한다. 메모리 예산의 동시성 통과는 원자성 증거로 쓰지 않는다.
// - 가격·한도 값은 모두 시험용 가상 값이다(운영 값 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget, createDbAiBudget, grantBudgetPermit, parseKrwLimit, type AiBudget, type ReserveContext, type Reservation } from '../../src/server/consult/chatModel';
import { createOpenAiChatModel, type OpenAiChatModelConfig } from '../../src/server/consult/openAiChatModel';
import { createOpenAiAdGenerator, type OpenAiAdGeneratorConfig } from '../../src/server/advertising/openAiAdGenerator';
import { withRecovery, RECOVERY_LIMITS } from '../../src/server/consult/modelRecovery';
import { createInflightGuard } from '../../src/server/consult/chatHandler';
import { estimateMaxKrw, priceFor, settleKrw, inputTokenUpperBound, type ModelPrice } from '../../src/server/ai/costModel';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const NOW = new Date('2026-11-23T12:00:00+09:00');
const KEY = 'sk-test-' + 'A'.repeat(30); // 가짜 키
const EP = 'https://model.example.test/v1/responses'; // 가짜 주소
const PRICES: readonly ModelPrice[] = [{ model: 'test-model', currency: 'KRW', inputKrwPerMTok: 100, outputKrwPerMTok: 400 }]; // 가상 가격
const SCOPE = 'ab'.repeat(32);
const ctx = (n: number): ReserveContext => ({ requestId: `req-mock-${String(n).padStart(12, '0')}`, scope: SCOPE });
const K = <T,>(value: T) => ({ known: true as const, value });
const rec = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic',
  productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved',
  confirmedAt: '2026-11-23T09:00:00+09:00', validFrom: '2026-11-23T00:00:00+09:00', validUntil: K('2026-11-24T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36),
  equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([]), regionScope: K('nationwide'),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
};
const input = (message = '요금이 얼마예요?', budgetCtx?: ReserveContext) => ({ message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', budgetCtx });
const okBody = (text = '안녕하세요. 승인된 안내입니다.', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], ...extra });

/** Mock Provider: 호출 횟수를 센다 */
function mockProvider(mode: { status?: number; text?: string; hang?: boolean } = {}) {
  const calls: string[] = [];
  const t: BodyTransport = async (_url, init) => {
    calls.push(new TextDecoder().decode(init.body));
    if (mode.hang) return new Promise(() => undefined);
    return { status: mode.status ?? 200, body: new Response(mode.text ?? okBody()).body };
  };
  return { t, calls };
}
const cfg = (t: BodyTransport | null, over: Partial<OpenAiChatModelConfig> = {}): OpenAiChatModelConfig => ({
  transport: t, endpoint: EP, apiKey: KEY, model: 'test-model', executionAllowed: true,
  costPerCallKrw: 10, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192, prices: PRICES, maxInputTokens: 4000, ...over,
});
/** 예약·확정·취소·불확실을 기록하는 감시 래퍼 */
function spyBudget(inner: AiBudget) {
  const log: string[] = [];
  const ctxs: (ReserveContext | undefined)[] = [];
  const b: AiBudget = {
    async reserve(cost, c) {
      ctxs.push(c);
      const r = await inner.reserve(cost, c);
      log.push(`reserve(${cost})=${r ? 'ok' : 'denied'}`);
      if (!r) return null;
      const w: Reservation = {
        async confirm(a) { log.push(`confirm(${a})`); return r.confirm(a); },
        async cancel() { log.push('cancel'); return r.cancel(); },
        async uncertain() { log.push('uncertain'); return r.uncertain ? r.uncertain() : r.confirm(cost); },
      };
      return w;
    },
  };
  return { b, log, ctxs };
}
const mem = (limit: string) => createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: limit });
const deps = (over: Record<string, unknown>) => ({ provider: () => [rec], supplierId: 'supplier-a', ...over }) as never;
const noSleep = async () => undefined;
const recovering = (t: BodyTransport, over: Partial<OpenAiChatModelConfig> = {}, rc: Record<string, unknown> = {}) =>
  withRecovery(createOpenAiChatModel(cfg(t, over)), { sleep: noSleep, ...rc } as never);

const SRC = path.resolve(__dirname, '../../src');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const srcFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
const grepSrc = (re: RegExp) => srcFiles.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f)).sort();
const MIG = readFileSync(path.resolve(__dirname, '../../db/migrations/0026_ai_cost_hardlimit.sql'), 'utf8');

// ───────── 요청당 한도 ─────────
test('L01 요청당 최대 입력: 300자 초과 입력 거부, 입력 토큰 상한(바이트 상한 가정) 초과는 전송 0회·예약 취소', async () => {
  const p = mockProvider();
  assert.equal((await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: mem('1000') }), input('가'.repeat(301)), NOW)).ok, false);
  const s = spyBudget(mem('1000'));
  await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { maxInputTokens: 64 })), budget: s.b }), input(), NOW);
  assert.equal(p.calls.length, 0);
  assert.deepEqual(s.log, ['reserve(10)=ok', 'cancel']);
});
test('L02 요청당 최대 출력 토큰: 범위(16~512) 밖은 전송 0회, 본문에 max_output_tokens 강제', async () => {
  for (const maxOutputTokens of [0, 15, 513, 100000, Number.NaN, 1.5]) {
    const p = mockProvider();
    await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { maxOutputTokens })), budget: mem('1000') }), input(), NOW);
    assert.equal(p.calls.length, 0, `maxOutputTokens=${maxOutputTokens}`);
  }
  const p = mockProvider();
  await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: mem('1000') }), input(), NOW);
  assert.equal(JSON.parse(p.calls[0]!).max_output_tokens, 200);
});
test('L03 요청당 예상 최대 비용: 예약 비용이 가격표 예상 최대 비용보다 작으면(과소 예약) 전송 0회', async () => {
  const pricey: ModelPrice[] = [{ model: 'test-model', currency: 'KRW', inputKrwPerMTok: 5000, outputKrwPerMTok: 20000 }]; // 예상 최대 = 24원
  assert.equal(estimateMaxKrw(pricey[0]!, 4000, 200), 24);
  for (const costPerCallKrw of [23, 0, -1, 1001, 1.5]) {
    const p = mockProvider();
    await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { prices: pricey, costPerCallKrw })), budget: mem('100000') }), input(), NOW);
    assert.equal(p.calls.length, 0, `cost=${costPerCallKrw}`);
  }
  const p = mockProvider();
  await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { prices: pricey, costPerCallKrw: 24 })), budget: mem('100000') }), input(), NOW);
  assert.equal(p.calls.length, 1);
});

// ───────── TEST-01~14 ─────────
test('TEST-01 정상 호출: 예약 → 전송 1회 → 확정 → 잔액 정확', async () => {
  const p = mockProvider();
  const s = spyBudget(mem('1000'));
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b }), input(), NOW);
  assert.ok(r.ok && r.source === 'model');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(s.log, ['reserve(10)=ok', 'confirm(10)']);
  assert.ok(await s.b.reserve(990)); assert.equal(await s.b.reserve(1), null);
});
test('TEST-02 일일 한도: 앱은 거부된 예약에서 Provider 0회(일일 판정 자체는 DB H2·D11)', async () => {
  const p = mockProvider();
  const denyDaily: AiBudget = { async reserve() { return null; } }; // DB가 일일 한도로 거부한 상황
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { costPerCallKrw: 20 })), budget: denyDaily }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 0);
  assert.match(MIG, /s\.day_all \+ p_cost > c\.daily_limit_krw/);
});
test('TEST-03 월 한도 10,000원·사용 9,995원·예상 10원 → 차단, Provider 0회', async () => {
  const p = mockProvider();
  const s = spyBudget(mem('10000'));
  assert.ok(await s.b.reserve(9995)); s.log.length = 0;
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 0);
  assert.deepEqual(s.log, ['reserve(10)=denied']);
});
test('TEST-04 (앱 참고) 동시 호출: 메모리 예산 경합은 참고용 — 원자성은 DB D1·D2·D10에서 서로 다른 세션으로 검증', async () => {
  const b = mem('100');
  const [a, c] = await Promise.all([b.reserve(80), b.reserve(80)]);
  assert.equal([a, c].filter(Boolean).length, 1);
});
test('TEST-05 Provider 무응답: 전송 1회, 환불하지 않고 "불확실"로 닫음(예약 전액 → 대표 조정 대기)', async () => {
  const p = mockProvider({ hang: true });
  const s = spyBudget(mem('1000'));
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b, timeoutMs: 40 }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(s.log, ['reserve(10)=ok', 'uncertain']);
  assert.equal(await s.b.reserve(991), null); // 불확실 10원이 그대로 잡혀 있다
});
test('TEST-05r 복구 래퍼 + 무응답: 추가 시도 없이 1회, 불확실(재시도 포함 예약 20원 전액 보존)', async () => {
  const p = mockProvider({ hang: true });
  const s = spyBudget(mem('1000'));
  await answerChat(deps({ model: recovering(p.t), budget: s.b, timeoutMs: 40 }), input(), NOW);
  assert.equal(p.calls.length, 1);
  assert.deepEqual(s.log, ['reserve(20)=ok', 'uncertain']);
});
test('TEST-06 Provider 429·500·503: 상한 안에서만 재시도(기본 2회, 최대 3회), 재시도 비용 사전 예약·실제 전송분 확정, 안전 안내문', async () => {
  for (const status of [429, 500, 503]) {
    const p = mockProvider({ status, text: 'upstream error ' + KEY });
    const s = spyBudget(mem('1000'));
    const r = await answerChat(deps({ model: recovering(p.t), budget: s.b }), input(), NOW);
    assert.ok(r.ok && r.source === 'fallback');
    assert.equal(p.calls.length, 2, `status ${status}`);
    assert.deepEqual(s.log, ['reserve(20)=ok', 'confirm(20)']);
    assert.ok(!JSON.stringify(r).includes(KEY) && !/HTTP_|upstream/.test(JSON.stringify(r)));
  }
  const p = mockProvider({ status: 503 });
  await answerChat(deps({ model: recovering(p.t, {}, { maxAttempts: 99 }), budget: mem('1000') }), input(), NOW);
  assert.equal(p.calls.length, RECOVERY_LIMITS.maxAttempts);
  const q = mockProvider({ status: 503 });
  const s = spyBudget(mem('15'));
  await answerChat(deps({ model: recovering(q.t), budget: s.b }), input(), NOW);
  assert.equal(q.calls.length, 0, '재시도 포함 예약(20) > 잔여(15)면 첫 호출도 없음');
});
test('TEST-06b 4xx 재시도 없음 / 차단기 열리면 Provider 0회·예약 취소', async () => {
  const p = mockProvider({ status: 401 });
  const s = spyBudget(mem('1000'));
  await answerChat(deps({ model: recovering(p.t), budget: s.b }), input(), NOW);
  assert.equal(p.calls.length, 1); assert.deepEqual(s.log, ['reserve(20)=ok', 'confirm(10)']);
  const q = mockProvider({ status: 503 });
  const model = recovering(q.t); const budget = mem('1000');
  for (let i = 0; i < 3; i++) await answerChat(deps({ model, budget }), input(), NOW);
  const before = q.calls.length; const s2 = spyBudget(budget);
  await answerChat(deps({ model, budget: s2.b }), input(), NOW);
  assert.equal(q.calls.length, before); assert.deepEqual(s2.log, ['reserve(20)=ok', 'cancel']);
});
test('TEST-07 사용량 누락·형식 이상: 0원 처리 금지 — 확정은 예약 전액, 비용 계산은 null(무료로 간주하지 않음)', async () => {
  for (const extra of [{}, { usage: null }, { usage: { input_tokens: 'x' } }]) {
    const p = mockProvider({ text: okBody('안녕하세요. 승인된 안내입니다.', extra) });
    const s = spyBudget(mem('1000'));
    await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b }), input(), NOW);
    assert.deepEqual(s.log, ['reserve(10)=ok', 'confirm(10)']);
  }
  for (const u of [undefined, null, {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 2 }]) assert.equal(settleKrw(PRICES[0]!, u), null, JSON.stringify(u));
  // 메모리·DB 예산 모두 확정 0원을 1원 이상으로 올린다(DB 0026 H6·D8은 0원 확정 자체를 거부)
  const b = mem('2'); const r = (await b.reserve(2))!; await r.confirm(0); assert.ok(await b.reserve(1)); assert.equal(await b.reserve(1), null);
});
test('TEST-08 긴급 차단: DB가 거부하면 Provider 0회(스위치 판정·감사·진행 중 기록은 DB H5)', async () => {
  const p = mockProvider();
  const paused: AiBudget = { async reserve() { return null; } };
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: paused }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 0);
  assert.match(MIG, /if c is null or c\.paused then\s+return null;/);
  assert.equal((await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: mem('0') }), input(), NOW)).ok, true);
  assert.equal(p.calls.length, 0, '월 한도 0원도 호출 금지');
});
test('TEST-09 환경변수 오류: 10진 정수만 인정, 그 외(미설정 포함) 호출 차단 + 관리자 확인용 기록(값 미노출)', async () => {
  for (const v of ['', '-5', 'abc', 'NaN', 'Infinity', '1e999', '-0', '12abc', '0x10', '1e3', '0b11', ' 5', '5 ', '1.5', '01', '1000001']) {
    const logs: string[] = [];
    const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: v }, (code, name) => logs.push(`${code} ${name}`));
    assert.equal(await b.reserve(1), null, `value=${JSON.stringify(v)}`);
    assert.deepEqual(logs, ['CONFIG_INVALID CONSULT_AI_MONTHLY_BUDGET_KRW'], `value=${JSON.stringify(v)}`);
  }
  assert.equal(await createAiBudget({}, () => assert.fail('미설정은 기본 0원(오류 아님)')).reserve(1), null);
  assert.deepEqual(['0', '7', '1000000'].map(parseKrwLimit), [0, 7, 1000000]);
  for (const over of [{ executionAllowed: 'true' }, { model: 'BAD MODEL' }, { prices: null }, { prices: [] }, { prices: [{ ...PRICES[0]!, currency: 'USD' }] },
    { prices: [PRICES[0]!, PRICES[0]!] }, { prices: [{ ...PRICES[0]!, inputKrwPerMTok: -1 }] }, { prices: [{ ...PRICES[0]!, outputKrwPerMTok: 1.5 }] }, { model: 'other-model' }]) {
    const p = mockProvider();
    await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, over as never)), budget: mem('1000') }), input(), NOW);
    assert.equal(p.calls.length, 0, JSON.stringify(over));
  }
});
test('TEST-10 비용 계산: 정수(BigInt)·올림·캐시 단가·모델별 가격·KRW만, 가격 없거나 불확실하면 null', () => {
  const p: ModelPrice = { model: 'm1', currency: 'KRW', inputKrwPerMTok: 1500, outputKrwPerMTok: 6000, cachedInputKrwPerMTok: 150 };
  assert.equal(estimateMaxKrw(p, 1000, 100), 3); // 1.5 + 0.6 = 2.1 → 올림 3
  assert.equal(estimateMaxKrw(p, 0, 0), 0);
  assert.equal(estimateMaxKrw(p, 1, 0), 1); // 0.0015원도 1원(과소 계산 금지)
  assert.equal(settleKrw(p, { inputTokens: 1000, outputTokens: 100 }), 3);
  assert.equal(settleKrw(p, { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 1000 }), 1); // 0.15 + 0.6 = 0.75 → 1
  assert.ok(settleKrw(p, { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 })! <= estimateMaxKrw(p, 1000, 100)!); // 정산 ≤ 상한
  assert.equal(estimateMaxKrw(p, 10_000_000, 10_000_000), 75000); // 큰 수도 정밀도 손실 없음
  assert.equal(estimateMaxKrw(p, -1, 0), null); assert.equal(estimateMaxKrw(p, 1.5, 0), null);
  assert.equal(priceFor([p], 'm2'), null); assert.equal(priceFor([{ ...p, currency: 'USD' }], 'm1'), null);
  assert.equal(priceFor([{ ...p, cachedInputKrwPerMTok: 2000 }], 'm1'), null, '캐시 단가가 일반 단가보다 비싸면 불확실');
  assert.equal(inputTokenUpperBound('가a'), 4); // UTF-8 바이트(한글 3 + 영문 1)
});
test('TEST-11 자정·월 전환: 일 키는 생성 시각의 KST 날짜(생성 열), 월 키는 KST YYYY-MM(실측은 DB H10·D6)', () => {
  assert.match(MIG, /day\s+date generated always as \(\(created_at at time zone 'Asia\/Seoul'\)::date\) stored/);
  assert.match(MIG, /v_month text := to_char\(v_now at time zone 'Asia\/Seoul', 'YYYY-MM'\)/);
  assert.match(MIG, /v_day\s+date := \(v_now at time zone 'Asia\/Seoul'\)::date/);
});
test('TEST-12 멱등: 같은 요청 ID 재전송은 다시 예약·전송하지 않는다(앱), DB는 동시 10건에도 1건(D9·H4)', async () => {
  const p = mockProvider();
  const d = deps({ model: createOpenAiChatModel(cfg(p.t)), budget: mem('1000') });
  await answerChat(d, input('요금이 얼마예요?', ctx(1)), NOW);
  const again = await answerChat(d, input('요금이 얼마예요?', ctx(1)), NOW);
  assert.equal(p.calls.length, 1);
  assert.ok(again.ok && again.source === 'fallback');
  await answerChat(d, input('요금이 얼마예요?', ctx(2)), NOW);
  assert.equal(p.calls.length, 2, '다른 요청 ID는 정상 처리');
});
test('TEST-12b DB 예산 어댑터: 요청 ID·사용자 키를 바인딩으로 넘기고, 형식이 틀리면 null을 넘겨 DB가 거부하게 한다', async () => {
  const vals: unknown[][] = [];
  const b = createDbAiBudget(async (fn) => fn(((s: TemplateStringsArray, ...v: unknown[]) => { vals.push(v); return Promise.resolve(s.join('?').includes('hold') ? [{ id: '7' }] : [{}]); }) as never));
  const h = await b.reserve(5, ctx(3));
  await h!.uncertain!();
  assert.deepEqual(vals[0], [5, 'req-mock-000000000003', SCOPE]);
  assert.deepEqual(vals[1], ['7']);
  vals.length = 0;
  await b.reserve(5, { requestId: 'x', scope: 'not-hex' });
  await b.reserve(5);
  assert.deepEqual(vals, [[5, null, null], [5, null, null]]);
});
test('TEST-12c 같은 세션 처리 중 중복 방어(메모리, 인스턴스별) — 다중 인스턴스 중복은 DB 요청 ID로 막는다', () => {
  const g = createInflightGuard(1000);
  assert.equal(g.enter('s:a', 0), true); assert.equal(g.enter('s:a', 10), false);
  g.leave('s:a'); assert.equal(g.enter('s:a', 20), true);
});
test('TEST-13 상담 중 한도 도달: 새 호출 차단, 승인 안내문만(모델 문구·추측 없음)', async () => {
  const p = mockProvider();
  const budget = mem('15');
  const d = deps({ model: createOpenAiChatModel(cfg(p.t)), budget });
  const first = await answerChat(d, input(), NOW);
  const second = await answerChat(d, input(), NOW);
  const baseline = await answerChat(deps({ model: null, budget }), input(), NOW);
  assert.ok(first.ok && first.source === 'model');
  assert.ok(second.ok && second.source === 'fallback');
  assert.equal(p.calls.length, 1);
  assert.ok(second.ok && baseline.ok && second.text === baseline.text);
});
test('TEST-14a 상담 어댑터 직접 호출(예약 없이)은 전송 0회 — 비용 게이트 허가 필요', async () => {
  const p = mockProvider();
  const m = createOpenAiChatModel(cfg(p.t));
  await assert.rejects(m.generate({ system: 's', user: 'u', approved: 'a' }, new AbortController().signal));
  await assert.rejects(m.generate({ system: 's', user: 'u', approved: 'a' }, new AbortController().signal, { sent: 0 }));
  await assert.rejects(withRecovery(m, { sleep: noSleep } as never).generate({ system: 's', user: 'u', approved: 'a' }, new AbortController().signal));
  assert.equal(p.calls.length, 0);
  const meter = { sent: 0 }; grantBudgetPermit(meter); // 허가가 있으면 전송(대조군)
  await m.generate({ system: 's', user: 'u', approved: 'a' }, new AbortController().signal, meter);
  assert.equal(p.calls.length, 1);
});
test('TEST-14b 광고 생성 어댑터: 예산 없음 → 0회, 예산 거부 → 0회, 허용 → 예약·1회·확정, 시간 초과 → 불확실', async () => {
  let calls = 0;
  const mk = (over: Partial<OpenAiAdGeneratorConfig>, status = 200, hang = false) => createOpenAiAdGenerator({
    transport: (async () => { calls++; if (hang) return new Promise(() => undefined); return { status, body: new Response(okBody(JSON.stringify({ title: 't', description: 'd' }))).body }; }) as never,
    apiKey: KEY, model: 'test-model', executionAllowed: true, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192,
    budget: mem('1000'), costPerCallKrw: 10, budgetScope: SCOPE, prices: PRICES, maxInputTokens: 4000, ...over,
  });
  const prompt = { instructions: 'i', input: 'x' };
  assert.equal((await mk({ budget: null }).generate(prompt)).kind, 'error');
  assert.deepEqual(await mk({ budget: { async reserve() { return null; } } }).generate(prompt), { kind: 'error', code: 'BUDGET_DENIED', called: false });
  assert.deepEqual(await mk({ budgetScope: null }).generate(prompt), { kind: 'error', code: 'NOT_CONFIGURED', called: false });
  assert.deepEqual(await mk({ prices: null }).generate(prompt), { kind: 'error', code: 'NOT_CONFIGURED', called: false });
  assert.deepEqual(await mk({ maxInputTokens: 64 }).generate({ instructions: 'i'.repeat(200), input: 'x' }), { kind: 'error', code: 'INPUT_TOO_LARGE', called: false });
  assert.equal(calls, 0);
  const s = spyBudget(mem('1000'));
  assert.equal((await mk({ budget: s.b }).generate(prompt)).kind, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(s.log, ['reserve(10)=ok', 'confirm(10)']);
  assert.ok(s.ctxs[0] && /^[0-9a-f-]{36}$/.test(s.ctxs[0].requestId) && s.ctxs[0].scope === SCOPE);
  const s2 = spyBudget(mem('1000'));
  assert.deepEqual(await mk({ budget: s2.b, timeoutMs: 1000 }, 200, true).generate(prompt), { kind: 'error', code: 'TIMEOUT', called: true });
  assert.deepEqual(s2.log, ['reserve(10)=ok', 'uncertain']);
});
test('TEST-14c 정적 점검: Provider 호출 코드는 두 어댑터뿐, 둘 다 게이트를 거치고, 허가는 chatAnswer만 붙인다', () => {
  assert.deepEqual(grepSrc(/OPENAI_RESPONSES_URL|api\.openai\.com|max_output_tokens:/), ['server/advertising/openAiAdGenerator.ts', 'server/consult/openAiChatModel.ts']);
  assert.match(readFileSync(path.join(SRC, 'server/consult/openAiChatModel.ts'), 'utf8'), /if \(!hasBudgetPermit\(meter\)\) throw new ModelNotCalledError/);
  assert.match(readFileSync(path.join(SRC, 'server/advertising/openAiAdGenerator.ts'), 'utf8'), /const hold = await \(cfg\.budget as AiBudget\)\.reserve\(/);
  assert.deepEqual(grepSrc(/grantBudgetPermit\(/), ['server/consult/chatAnswer.ts', 'server/consult/chatModel.ts']);
});
test('TEST-14d 상담 경로: 예약 거부 시 모델 generate 미호출, 예약 문맥(요청 ID·사용자 키)을 그대로 전달', async () => {
  let generated = 0;
  const model = { name: 'fake', costPerCallKrw: 10, async generate() { generated++; return 'x'; } };
  await answerChat(deps({ model, budget: mem('5') }), input(), NOW);
  assert.equal(generated, 0);
  const s = spyBudget(mem('1000'));
  await answerChat(deps({ model, budget: s.b }), input('요금이 얼마예요?', ctx(9)), NOW);
  assert.deepEqual(s.ctxs[0], ctx(9));
});
