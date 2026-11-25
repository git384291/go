// AI 장애·타임아웃 자동복구 최종검증(PM 11/24) — 가짜 모델·가짜 transport만. 실제 AI 호출 0회, 실고객 데이터 없음.
// 기존 RC1~RC15(consult-recovery)·TEST-01~14(ai-cost-hardlimit-mock)·DB D1~D14·C4d에 없는 상황만 더한다:
// 응답 도중 연결 종료, 동시 100건(정상·한도·장애·복구), 장애 중 재시도 몰림, 같은 요청 100건, 장애 기록·개인정보.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerChat, CALLBACK_PROMPT, type AiFailureEvent } from '../../src/server/consult/chatAnswer';
import { createAiBudget, grantBudgetPermit, type AiBudget, type ChatModel, type ModelInput, type Reservation } from '../../src/server/consult/chatModel';
import { createInflightGuard, createLimiter, handleChat } from '../../src/server/consult/chatHandler';
import { createOpenAiChatModel, type OpenAiChatModelConfig } from '../../src/server/consult/openAiChatModel';
import { ModelCallError, withRecovery, type RecoveryEvent } from '../../src/server/consult/modelRecovery';
import { AI_UNAVAILABLE_GUIDANCE } from '../../src/content/consultGuidance';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const NOW = new Date('2026-11-23T12:00:00+09:00');
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
const SCOPE = 'c'.repeat(64);
const input = (message = '요금이 얼마예요?', requestId?: string) => ({ message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', ...(requestId ? { budgetCtx: { requestId, scope: SCOPE } } : {}) });
const OK_TEXT = (i: ModelInput) => `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${i.approved}`;
const KEY = 'sk-test-' + 'A'.repeat(30);
const sig = () => new AbortController().signal;
const permit = () => { const m = { sent: 0 }; grantBudgetPermit(m); return m; };
const tick = () => new Promise<void>((r) => setImmediate(r));

/** 예약·정산을 기록하는 예산(안쪽은 실제 메모리 예산: 한도·같은 요청 ID 거부·1원 하한 그대로) */
function spyBudget(limitKrw: number) {
  const log: { k: 'hold' | 'denied' | 'confirm' | 'cancel' | 'uncertain'; krw: number }[] = [];
  const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: String(limitKrw) });
  const budget: AiBudget = {
    async reserve(cost, ctx) {
      const r = await inner.reserve(cost, ctx);
      if (!r) { log.push({ k: 'denied', krw: 0 }); return null; }
      log.push({ k: 'hold', krw: cost });
      const w: Reservation = {
        async confirm(a) { log.push({ k: 'confirm', krw: a }); await r.confirm(a); },
        async cancel() { log.push({ k: 'cancel', krw: 0 }); await r.cancel(); },
        async uncertain() { log.push({ k: 'uncertain', krw: cost }); await r.uncertain?.(); },
      };
      return w;
    },
  };
  const n = (k: string) => log.filter((x) => x.k === k).length;
  /** 정산된 사용액: 확정은 실제 금액, 불확실은 예약 전액, 취소 0 */
  const spent = () => log.reduce((s, x) => s + (x.k === 'confirm' || x.k === 'uncertain' ? x.krw : 0), 0);
  return { budget, log, n, spent };
}
/** 단계 함수로 동작하는 가짜 모델(비동기: 동시 요청이 실제로 겹친다) */
function fakeModel(step: (n: number, i: ModelInput) => 'ok' | 'server' | 'rate' | 'net' | 'plain', cost = 5) {
  const st = { calls: 0, inputs: [] as string[] };
  const m: ChatModel = {
    name: 'fake', costPerCallKrw: cost,
    async generate(i) {
      const n = ++st.calls;
      st.inputs.push(i.user);
      await tick();
      const s = step(n, i);
      if (s === 'ok') return OK_TEXT(i);
      if (s === 'server') throw new ModelCallError('HTTP_ERROR', 'server', 503);
      if (s === 'rate') throw new ModelCallError('HTTP_RATE_LIMITED', 'rate_limited', 429);
      if (s === 'net') throw new ModelCallError('TRANSPORT_ERROR', 'network');
      throw new Error(`provider echo ${i.user} ${KEY}`); // 원문에 고객 글·키가 섞인 오류(기록·응답에 나가면 안 됨)
    },
  };
  return { m, st };
}
const deps = (model: ChatModel | null, budget: AiBudget, failureLog?: (e: AiFailureEvent) => void) =>
  ({ provider: () => [rec], supplierId: 'supplier-a', model, budget, failureLog: failureLog ?? (() => {}) }) as never;
const fast = (over: Record<string, unknown> = {}) => ({ sleep: async () => { await tick(); }, baseDelayMs: 10, maxDelayMs: 40, attemptMs: 2000, totalMs: 6000, log: () => {}, ...over });

// ───── R6: 응답 도중 연결 종료·부분 응답 ─────
const EP = 'https://model.example.test/v1/responses';
const cfg = (t: BodyTransport): OpenAiChatModelConfig => ({ transport: t, endpoint: EP, apiKey: KEY, model: 'test-model', executionAllowed: true, costPerCallKrw: 5, maxOutputTokens: 200, timeoutMs: 5000, maxResponseBytes: 8192, prices: [{ model: 'test-model', currency: 'KRW', inputKrwPerMTok: 100, outputKrwPerMTok: 400 }], maxInputTokens: 4000 });
const enc = (s: string) => new TextEncoder().encode(s);
const full = (text: string, status = 'completed') => JSON.stringify({ status, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
/** 응답 본문: 첫 조각을 보낸 뒤 연결이 끊긴다(read reject) */
const dropMidway = (first: string) => { let sent = false; return new ReadableStream<Uint8Array>({ pull(c) { if (!sent) { sent = true; c.enqueue(enc(first)); } else c.error(new Error('ECONNRESET ' + KEY)); } }); };
const closeMidway = (first: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(first)); c.close(); } });
function transport(bodies: (() => ReadableStream<Uint8Array>)[]) {
  const st = { calls: 0 };
  const t: BodyTransport = async () => { const b = bodies[Math.min(st.calls, bodies.length - 1)]!; st.calls++; return { status: 200, body: b() }; };
  return { t, st };
}
const PARTIAL = '{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"월 99,000원에 상품권 50만';

test('RF1 응답 도중 연결 종료(R6): 끊긴 응답은 버리고 상한 안에서 1번 다시 시도해 복구, 비용은 보낸 2회만큼 확정', async () => {
  const tr = transport([() => dropMidway(PARTIAL), () => new Response(full('문의 주셔서 감사합니다. 현재 확인된 안내입니다.')).body!]);
  const b = spyBudget(1000);
  const r = await answerChat(deps(withRecovery(createOpenAiChatModel(cfg(tr.t)), fast()), b.budget), input(), NOW);
  assert.ok(r.ok && r.source === 'model');
  assert.equal(tr.st.calls, 2, '끊긴 1회 + 다시 시도 1회');
  assert.ok(r.ok && !r.text.includes('99,000') && !r.text.includes('50만'), '끊긴 조각의 글은 고객에게 나가지 않는다');
  assert.deepEqual(b.log.map((x) => `${x.k}:${x.krw}`), ['hold:10', 'confirm:10'], '예약 = 5원×최대 2회, 확정 = 실제 보낸 2회');
});

test('RF1b 계속 끊기면: 시도 2회에서 멈추고 과금 불확실(예약 전액·대표 조정), 고객에게는 A 안내 + 승인 견적만', async () => {
  const tr = transport([() => dropMidway(PARTIAL)]);
  const b = spyBudget(1000);
  const events: AiFailureEvent[] = [];
  const r = await answerChat(deps(withRecovery(createOpenAiChatModel(cfg(tr.t)), fast()), b.budget, (e) => events.push(e)), input(), NOW);
  assert.equal(tr.st.calls, 2);
  assert.ok(r.ok && r.source === 'fallback' && r.text.startsWith(AI_UNAVAILABLE_GUIDANCE) && r.text.includes('11,111') && !r.text.includes('99,000'));
  assert.ok(r.ok && r.next !== 'blocked', 'AI 장애만으로 접수를 막지 않는다(사람 상담 경로 유지)');
  assert.deepEqual(b.log.map((x) => x.k), ['hold', 'uncertain']);
  assert.deepEqual(events, [{ stage: 'failed', code: 'NETWORK', status: null, sent: 2, settle: 'uncertain' }]);
});

test('RF1c 부분 응답(정상 종료지만 잘린 JSON·미완료 status): 다시 시도하지 않고(1회) 비용 확정, 잘린 글은 버림', async () => {
  for (const body of [() => closeMidway(PARTIAL), () => new Response(full('월 99,000원에 상품권', 'incomplete')).body!]) {
    const tr = transport([body]);
    const b = spyBudget(1000);
    const r = await answerChat(deps(withRecovery(createOpenAiChatModel(cfg(tr.t)), fast()), b.budget), input(), NOW);
    assert.equal(tr.st.calls, 1, '형식 오류·미완료는 다시 보내도 같은 결과 → 재시도 없음');
    assert.ok(r.ok && r.source === 'fallback' && !r.text.includes('99,000'));
    assert.deepEqual(b.log.map((x) => `${x.k}:${x.krw}`), ['hold:10', 'confirm:5']);
  }
});

// ───── R10·R12: 동시 100건 ─────
test('RF2 동시 100건 정상: 모델 정확히 100회, 100건 모두 모델 답변, 예약 100건·확정 100건(각 5원), 중복 정산 0', async () => {
  const f = fakeModel(() => 'ok');
  const b = spyBudget(1000);
  const w = withRecovery(f.m, fast());
  const rs = await Promise.all(Array.from({ length: 100 }, () => answerChat(deps(w, b.budget), input(), NOW)));
  assert.equal(rs.filter((r) => r.ok && r.source === 'model').length, 100);
  assert.equal(f.st.calls, 100);
  assert.deepEqual([b.n('hold'), b.n('confirm'), b.n('denied'), b.n('cancel'), b.n('uncertain')], [100, 100, 0, 0, 0]);
  assert.equal(b.spent(), 500);
});

test('RF3 동시 100건 + 비용 한도(R12): 예약 37건분 한도면 모델은 37회만, 63건은 호출 0회·안내문, 사용액은 한도 이하(재시도 포함)', async () => {
  const f = fakeModel((n) => (n % 2 ? 'server' : 'ok')); // 절반은 1번 실패 후 재시도
  const b = spyBudget(370); // 예약 1건 = 5원×2회 = 10원 → 37건
  const events: AiFailureEvent[] = [];
  const w = withRecovery(f.m, fast({ breakerFailures: 10 }));
  const rs = await Promise.all(Array.from({ length: 100 }, () => answerChat(deps(w, b.budget, (e) => events.push(e)), input(), NOW)));
  assert.equal(b.n('hold'), 37);
  assert.equal(b.n('denied'), 63);
  assert.ok(f.st.calls >= 37 && f.st.calls <= 74, `모델 호출은 예약된 37건 × 최대 2회 안(${f.st.calls})`);
  assert.ok(b.spent() <= 370, `사용액 ${b.spent()} ≤ 한도 370`);
  assert.equal(rs.filter((r) => r.ok && r.source === 'fallback' && r.text.startsWith(AI_UNAVAILABLE_GUIDANCE)).length >= 63, true);
  assert.equal(events.filter((e) => e.stage === 'budget_denied' && e.code === 'BUDGET_DENIED' && e.sent === 0).length, 63);
  // 정산 뒤 반환된 예약분만큼은 다시 쓸 수 있고(정상), 그 뒤에는 차단된다: 이어서 100건을 보내도 사용액은 끝까지 한도 이하
  for (let i = 0; i < 100; i++) await answerChat(deps(w, b.budget), input(), NOW);
  assert.ok(b.spent() <= 370, `연속 요청 뒤 사용액 ${b.spent()} ≤ 370`);
  const before = f.st.calls;
  const holds = b.n('hold');
  const later = await answerChat(deps(w, b.budget), input(), NOW);
  assert.ok(later.ok && later.source === 'fallback', '한도 소진 뒤 새 요청은 안내문');
  assert.deepEqual([f.st.calls, b.n('hold')], [before, holds], '한도 소진 뒤 호출 0회·예약 0건');
});

test('RF4 동시 100건 장애(503) → 차단 → 복구: 호출은 100×2 이하, 차단 중 100건은 0회·0원, 시간 경과 뒤 시험 호출 1회만, 이후 100건 정상', async () => {
  let t = 1_000_000;
  let healthy = false;
  const f = fakeModel(() => (healthy ? 'ok' : 'server'));
  const b = spyBudget(1_000_000);
  const evs: RecoveryEvent[] = [];
  const w = withRecovery(f.m, fast({ now: () => t, breakerFailures: 3, breakerOpenMs: 30_000, log: (e: RecoveryEvent) => evs.push(e) }));
  const wave = (msg?: string) => Promise.all(Array.from({ length: 100 }, () => answerChat(deps(w, b.budget), input(msg), NOW)));
  // 1) 장애 중 동시 100건
  const r1 = await wave();
  assert.ok(f.st.calls >= 100 && f.st.calls <= 200, `호출 ${f.st.calls} ≤ 100건×최대 2회`);
  assert.ok(r1.every((r) => r.ok && r.source === 'fallback' && r.text.startsWith(AI_UNAVAILABLE_GUIDANCE) && r.next !== 'blocked'), '모두 A 안내, 접수 경로 유지');
  assert.equal(evs.filter((e) => e === 'breaker_open').length, 1, '차단기 열림 기록 1회(폭주 기록 없음)');
  assert.ok(b.spent() <= b.n('hold') * 10, '확정 합계 ≤ 예약 합계');
  // 2) 차단 중 동시 100건: 모델 0회, 전부 취소(0원)
  const c1 = f.st.calls, cancels = b.n('cancel');
  const r2 = await wave('잘 모르겠어요');
  assert.equal(f.st.calls, c1, '차단 중 호출 0회');
  assert.equal(b.n('cancel') - cancels, 100, '차단 중 예약은 모두 취소(0원)');
  assert.ok(r2.every((r) => r.ok && r.next === 'callback' && r.callbackPrompt === CALLBACK_PROMPT), '모르겠다는 고객에게는 대표 직접 연락(사람 상담) 동의 안내');
  // 3) 시간 경과·복구: 동시 100건 중 시험 호출은 1건만
  t += 30_001; healthy = true;
  const c2 = f.st.calls;
  const r3 = await wave();
  assert.equal(f.st.calls - c2, 1, '반열림 시험 호출 1회');
  assert.equal(r3.filter((r) => r.ok && r.source === 'model').length, 1);
  assert.deepEqual(evs, ['breaker_open', 'breaker_recovered']);
  // 4) 복구 뒤 동시 100건 정상
  const c3 = f.st.calls;
  const r4 = await wave();
  assert.equal(f.st.calls - c3, 100);
  assert.ok(r4.every((r) => r.ok && r.source === 'model'));
});

test('RF5 장애 중 재시도 몰림 방지(R10 결함 수정): 대기하던 요청은 그사이 다른 요청들로 차단기가 열리면 다시 시도하지 않는다', async () => {
  const f = fakeModel(() => 'server', 0);
  let w: ChatModel | null = null;
  let first = true;
  const sleep = async () => {
    if (!first) return;
    first = false; // A가 1회 실패 후 대기하는 동안 다른 요청 3건이 끝까지 실패 → 차단기 열림
    for (let i = 0; i < 3; i++) await w!.generate({ system: 'S', user: 'u', approved: 'a' }, sig(), permit()).catch(() => {});
  };
  const evs: RecoveryEvent[] = [];
  w = withRecovery(f.m, { sleep, breakerFailures: 3, breakerOpenMs: 30_000, baseDelayMs: 10, maxDelayMs: 40, log: (e) => evs.push(e) });
  await assert.rejects(w.generate({ system: 'S', user: 'u', approved: 'a' }, sig(), permit()), ModelCallError);
  assert.equal(f.st.calls, 1 + 3 * 2, 'A는 1회에서 멈춤(수정 전에는 A가 1번 더 보내 8회)');
  assert.deepEqual(evs, ['breaker_open']);
});

test('RF6 같은 요청 100건(재전송 폭주, R5): 같은 요청 ID 동시 100건 → 예약 1건·모델 1회, 같은 세션 동시 100건 → 처리 1건·나머지 BUSY', async () => {
  const f = fakeModel(() => 'ok');
  const b = spyBudget(100_000);
  const w = withRecovery(f.m, fast());
  const rs = await Promise.all(Array.from({ length: 100 }, () => answerChat(deps(w, b.budget), input('요금?', 'req-same-0000000000001'), NOW)));
  assert.deepEqual([b.n('hold'), b.n('denied'), f.st.calls], [1, 99, 1]);
  assert.equal(rs.filter((r) => r.ok && r.source === 'model').length, 1);
  // 같은 세션: 처리 중이면 BUSY(모델 호출 전 차단)
  let release: () => void = () => {};
  let calls = 0;
  const slow: ChatModel = { name: 's', costPerCallKrw: 0, generate: (i) => { calls++; return new Promise((res) => { release = () => res(OK_TEXT(i)); }); } };
  const KEYB = Buffer.alloc(32, 7);
  const guard = createInflightGuard();
  const HD = (model: ChatModel) => ({ enabled: true, chat: deps(model, createAiBudget({})), limiter: createLimiter(1000, 60_000), ip: '203.0.113.9', now: () => NOW, sessionKey: KEYB, newSessionLimiter: createLimiter(1000, 60_000), botCheck: async () => 'ok', rateLimit: async () => true, inflight: guard }) as never;
  const post = (body: unknown) => new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(body) });
  const good = { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?' };
  const s0 = await (await handleChat(post(good), HD(fakeModel(() => 'ok', 0).m))).json() as { session: string };
  const pending = Array.from({ length: 100 }, () => handleChat(post({ ...good, session: s0.session }), HD(slow)));
  await tick(); await tick();
  release();
  const res = await Promise.all(pending);
  const codes = await Promise.all(res.map(async (r) => `${r.status}:${((await r.json()) as { code?: string }).code ?? 'ok'}`));
  assert.equal(calls, 1);
  assert.equal(codes.filter((c) => c === '200:ok').length, 1);
  assert.equal(codes.filter((c) => c === '429:BUSY').length, 99);
});

test('RF7 장애 기록(R8): 고정 형식 1줄(단계·코드·상태·보낸 횟수·정산), 기록이 실패해도 상담은 정상 응답', async () => {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    const b = spyBudget(10);
    const f = fakeModel(() => 'rate');
    const m = withRecovery(f.m, { sleep: async () => {}, baseDelayMs: 10, maxDelayMs: 40, breakerFailures: 1, breakerOpenMs: 30_000 });
    const d = { provider: () => [rec], supplierId: 'supplier-a', model: m, budget: b.budget } as never; // 기본 기록기
    await answerChat(d, input(), NOW); // 429 ×2 → 확정, 차단기 열림
    await answerChat(d, input(), NOW); // 한도 소진 → budget_denied
    const fmt = /^\[ai-chat\] (budget_denied|not_called|failed) code=[A-Z][A-Z_]* status=(\d{3}|-) sent=\d+ settle=(none|cancel|uncertain|confirm)$|^\[ai-recovery\] (breaker_open|breaker_recovered) failures=\d+$/;
    assert.deepEqual(lines, ['[ai-recovery] breaker_open failures=1', '[ai-chat] failed code=RATE_LIMITED status=429 sent=2 settle=confirm', '[ai-chat] budget_denied code=BUDGET_DENIED status=- sent=0 settle=none']);
    assert.ok(lines.every((l) => fmt.test(l)));
  } finally { console.warn = orig; }
  // 기록기가 던져도 고객 응답은 정상
  const f2 = fakeModel(() => 'server');
  const r = await answerChat(deps(withRecovery(f2.m, fast({ log: () => { throw new Error('log down'); } })), spyBudget(1000).budget, () => { throw new Error('log down'); }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
});

test('RF8 개인정보·비밀(R11): 이름·연락처·주소·키·토큰이 모델 입력(가림 뒤)·고객 응답·장애 기록·HTTP 응답 어디에도 원문으로 나가지 않는다', async () => {
  const TOKEN = 'eyJ' + 'z'.repeat(60); // 가짜 토큰 모양(시험 데이터)
  const msg = `저는 홍길동이고 010-1234-5678, 주안로 12 살아요. 키 ${KEY} 토큰 ${TOKEN}`;
  const SECRETS = ['홍길동', '010-1234-5678', '1234-5678', '주안로 12', KEY, TOKEN, 'provider echo'];
  const logged: string[] = [];
  const evs: string[] = [];
  const f = fakeModel(() => 'plain'); // 원문(고객 글·키)이 섞인 오류
  const w = withRecovery(f.m, fast({ log: (e: RecoveryEvent, n: number) => evs.push(`${e}:${n}`) }));
  const r = await answerChat(deps(w, spyBudget(1000).budget, (e) => logged.push(JSON.stringify(e))), input(msg), NOW);
  const out = JSON.stringify(r) + logged.join('\n') + evs.join('\n');
  for (const s of SECRETS) assert.ok(!out.includes(s), `응답·기록에 노출: ${s}`);
  // 통합(11/25): PR #2 데이터 최소화(P0) — 개인정보 신호가 있으면 모델 호출 0회·장애 기록 없음(더 엄격한 규칙으로 기대값 변경)
  assert.equal(f.st.inputs.length, 0, '개인정보 글은 모델로 보내지 않는다');
  assert.deepEqual(logged, []);
  // 깨끗한 글 + 원문 섞인 알 수 없는 오류: 고정 코드만 기록(기존 RF8 검사 유지)
  const r2 = await answerChat(deps(w, spyBudget(1000).budget, (e) => logged.push(JSON.stringify(e))), input('인터넷 요금이 궁금해요'), NOW);
  const out2 = JSON.stringify(r2) + logged.join('\n') + evs.join('\n');
  for (const s of [KEY, TOKEN, 'provider echo']) assert.ok(!out2.includes(s), `응답·기록에 노출: ${s}`);
  assert.deepEqual(logged.map((l) => JSON.parse(l).code), ['UNKNOWN'], '알 수 없는 오류의 원문 대신 고정 코드');
  // HTTP 경로: 오류·안내 응답 본문에도 원문 없음
  const post = (body: unknown) => new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(body) });
  const HD = { enabled: true, chat: deps(w, spyBudget(1000).budget, (e) => logged.push(JSON.stringify(e))), limiter: createLimiter(1000, 60_000), ip: '203.0.113.9', now: () => NOW, sessionKey: Buffer.alloc(32, 7), newSessionLimiter: createLimiter(1000, 60_000), botCheck: async () => 'ok', rateLimit: async () => true, inflight: createInflightGuard() } as never;
  for (const body of [{ carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: msg }, { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: msg, extra: KEY }]) {
    const text = await (await handleChat(post(body), HD)).text();
    for (const s of SECRETS) assert.ok(!text.includes(s), `HTTP 응답에 노출: ${s}`);
  }
});
