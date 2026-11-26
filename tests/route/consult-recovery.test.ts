// 상담 AI 장애·타임아웃 자동 복구 시험(PM 11/24) — 가짜 모델·가짜 transport만. 실제 유료 API 호출 0회.
import { test } from 'node:test';
import { grantBudgetPermit } from '../../src/server/consult/chatModel';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerChat, chatTimeoutMs } from '../../src/server/consult/chatAnswer';
import { createAiBudget, ModelNotCalledError } from '../../src/server/consult/chatModel';
import type { AiBudget, CallMeter, ChatModel, ModelInput } from '../../src/server/consult/chatModel';
import { createInflightGuard, createLimiter, handleChat } from '../../src/server/consult/chatHandler';
import { createOpenAiChatModel, type OpenAiChatModelConfig } from '../../src/server/consult/openAiChatModel';
import { isRetryableModelError, ModelCallError, RECOVERY_LIMITS, recoveringModelFor, withRecovery, type ModelFailureKind } from '../../src/server/consult/modelRecovery';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';
const permit = () => { const m = { sent: 0 }; grantBudgetPermit(m); return m; }; // 0025: 비용 게이트 허가(시험용)

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
const input = (message: unknown = '요금이 얼마예요?') => ({ message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' });
const deps = (over: Record<string, unknown> = {}) => ({ provider: () => [rec], supplierId: 'supplier-a', model: null, budget: createAiBudget({}), ...over }) as never;
const IN: ModelInput = { system: 'SYS', user: '요금이 궁금해요', approved: '월 11,111원' };
const sig = () => new AbortController().signal;
const KEY = 'sk-test-' + 'A'.repeat(30);

type Step = 'ok' | ModelFailureKind | 'hang' | 'plain' | 'notcalled';
const err = (k: ModelFailureKind) => new ModelCallError(k === 'rate_limited' ? 'HTTP_RATE_LIMITED' : k === 'server' || k === 'client' ? 'HTTP_ERROR' : k.toUpperCase(), k, k === 'rate_limited' ? 429 : k === 'server' ? 503 : k === 'client' ? 401 : undefined);
/** 단계표대로 동작하는 가짜 모델. 단계표가 끝나면 마지막 단계를 반복 */
function script(steps: Step[], cost = 0) {
  const st = { calls: 0 };
  const m: ChatModel = {
    name: 'fake', costPerCallKrw: cost,
    async generate(i) {
      const s = steps[Math.min(st.calls, steps.length - 1)]!;
      st.calls++;
      if (s === 'ok') return `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${i.approved}`;
      if (s === 'hang') return new Promise<string>(() => {});
      if (s === 'plain') throw new Error('SECRET ' + KEY);
      if (s === 'notcalled') throw new ModelNotCalledError('NOT_CONFIGURED');
      throw err(s);
    },
  };
  return { m, st };
}
const noSleep = () => { const delays: number[] = []; return { delays, sleep: async (ms: number) => { delays.push(ms); } }; };
const fast = { baseDelayMs: 10, maxDelayMs: 40, attemptMs: 60 };

test('RC1 재시도 가능 분류: timeout·네트워크·429·5xx만, 4xx·응답 형식·거절·일반 오류는 불가', () => {
  for (const k of ['timeout', 'network', 'rate_limited', 'server'] as const) assert.equal(isRetryableModelError(err(k)), true, k);
  for (const k of ['client', 'response'] as const) assert.equal(isRetryableModelError(err(k)), false, k);
  assert.equal(isRetryableModelError(new Error('x')), false);
  assert.equal(isRetryableModelError(new ModelNotCalledError('x')), false);
  assert.equal(isRetryableModelError(null), false);
});

test('RC2 어댑터 오류 분류(가짜 transport): 429·5xx·네트워크·timeout·4xx·형식 이상·거절, 키·본문 반사 없음', async () => {
  const cfg = (t: BodyTransport, over: Partial<OpenAiChatModelConfig> = {}): OpenAiChatModelConfig => ({ transport: t, endpoint: 'https://model.example.test/v1/responses', apiKey: KEY, model: 'test-model', executionAllowed: true, costPerCallKrw: 5, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192, prices: [{ model: 'test-model', currency: 'KRW', inputKrwPerMTok: 100, outputKrwPerMTok: 400 }], maxInputTokens: 4000, ...over });
  const resp = (status: number, text = '{}'): BodyTransport => async () => ({ status, body: new Response(text).body });
  const kindOf = async (t: BodyTransport) => {
    const e = await createOpenAiChatModel(cfg(t)).generate(IN, sig(), permit()).catch((x: unknown) => x);
    assert.ok(e instanceof ModelCallError, String(e));
    assert.ok(!(e as Error).message.includes(KEY) && !(e as Error).message.includes('secret-body'));
    return [(e as ModelCallError).kind, (e as ModelCallError).status ?? 0, (e as Error).message];
  };
  assert.deepEqual(await kindOf(resp(429, 'secret-body')), ['rate_limited', 429, 'HTTP_RATE_LIMITED']);
  for (const s of [500, 502, 503, 504]) assert.deepEqual(await kindOf(resp(s, 'secret-body')), ['server', s, 'HTTP_ERROR']);
  for (const s of [400, 401, 403, 404]) assert.deepEqual(await kindOf(resp(s, 'secret-body')), ['client', s, 'HTTP_ERROR']);
  assert.deepEqual((await kindOf(async () => { throw new Error('network ' + KEY); })).slice(0, 2), ['network', 0]);
  assert.deepEqual((await kindOf(() => new Promise(() => {}))).slice(0, 2), ['timeout', 0]); // 마감(1초) 뒤 timeout
  assert.equal((await kindOf(resp(200, 'not json')))[0], 'response');
  assert.equal((await kindOf(resp(200, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'x' }] }] }))))[0], 'response');
});

test('RC3 복구: timeout·네트워크·429·5xx는 1번 다시 시도해 성공하고, 대기는 짧은 상한 안', async () => {
  for (const k of ['timeout', 'network', 'rate_limited', 'server'] as const) {
    const { m, st } = script([k, 'ok']);
    const s = noSleep();
    const out = await withRecovery(m, { ...s, baseDelayMs: 400, maxAttempts: 2 }).generate(IN, sig());
    assert.ok(out.includes('11,111'), k);
    assert.equal(st.calls, 2, k);
    assert.deepEqual(s.delays, [400], k);
  }
  // 호출이 끝나지 않는 hang도 시도별 시간 제한(attemptMs)으로 끊고 다음 시도로 복구
  const { m, st } = script(['hang', 'ok']);
  const out = await withRecovery(m, { ...fast, sleep: async () => {} }).generate(IN, sig());
  assert.ok(out.includes('11,111') && st.calls === 2);
});

test('RC4 하드 상한: 설정을 99·무한으로 줘도 시도 3회·대기 2초·전체 7초를 넘지 않는다', async () => {
  const { m, st } = script(['server']);
  const s = noSleep();
  const w = withRecovery(m, { ...s, maxAttempts: 99, baseDelayMs: 99999, maxDelayMs: 99999, totalMs: 99999999, attemptMs: 99999999 });
  await assert.rejects(w.generate(IN, sig()), ModelCallError);
  assert.equal(st.calls, RECOVERY_LIMITS.maxAttempts);
  assert.equal(s.delays.length, 2);
  assert.ok(s.delays.every((d) => d <= RECOVERY_LIMITS.maxDelayMs), s.delays.join());
  assert.deepEqual([RECOVERY_LIMITS.maxAttempts, RECOVERY_LIMITS.maxDelayMs, RECOVERY_LIMITS.maxTotalMs], [3, 2000, 7000]);
  // 이상한 값(NaN·음수)은 기본값으로
  const b = script(['server']);
  await assert.rejects(withRecovery(b.m, { ...noSleep(), maxAttempts: Number.NaN, baseDelayMs: -5 }).generate(IN, sig()));
  assert.equal(b.st.calls, 2);
});

test('RC5 전체 시간 상한: 시도가 느려 남은 시간이 없으면 다시 시도하지 않는다(가짜 시계)', async () => {
  let t = 0;
  const calls = { n: 0 };
  const m: ChatModel = { name: 'slow', costPerCallKrw: 0, async generate() { calls.n++; t += 3000; throw err('server'); } };
  const w = withRecovery(m, { now: () => t, sleep: async (ms) => { t += ms; }, maxAttempts: 3, totalMs: 6500, baseDelayMs: 400, attemptMs: 3500 });
  await assert.rejects(w.generate(IN, sig()), ModelCallError);
  // t: 0→3000(1차) →3400(대기 400) →6400(2차) → 대기 800은 남은 100ms보다 길어 중단
  assert.equal(calls.n, 2);
  assert.ok(t <= 7000, String(t));
});

test('RC6 재시도하면 안 되는 오류는 정확히 1회: 4xx·응답 형식·일반 오류, 요청 전 실패(ModelNotCalledError)는 그대로 전달', async () => {
  for (const s of ['client', 'response', 'plain'] as const) {
    const { m, st } = script([s]);
    await assert.rejects(withRecovery(m, noSleep()).generate(IN, sig()));
    assert.equal(st.calls, 1, s);
  }
  const n = script(['notcalled']);
  await assert.rejects(withRecovery(n.m, noSleep()).generate(IN, sig()), ModelNotCalledError);
  assert.equal(n.st.calls, 1);
});

test('RC7 비용: 예약은 재시도 포함 최대(1,000원 이하), 확정은 실제 보낸 횟수만큼 — 성공 5원·재시도 후 성공 10원·전부 실패 15원·차단 0원', async () => {
  const rows: string[] = [];
  const budget: AiBudget = { async reserve(c) { rows.push('R' + c); return { async confirm(a) { rows.push('C' + a); }, async cancel() { rows.push('X'); } }; } };
  const run = async (steps: Step[]) => {
    rows.length = 0;
    const r = await answerChat(deps({ budget, model: withRecovery(script(steps, 5).m, noSleep()) }), input(), NOW);
    return [r.ok ? r.source : 'bad', ...rows];
  };
  assert.deepEqual(await run(['ok']), ['model', 'R10', 'C5']); // 기본 2회 시도 → 예약 10원
  assert.deepEqual(await run(['server', 'ok']), ['model', 'R10', 'C10']);
  assert.deepEqual(await run(['server', 'server']), ['fallback', 'R10', 'C10']);
  assert.deepEqual(await run(['client']), ['fallback', 'R10', 'C5']); // 4xx는 1회만
  // 유료 모델 비용이 커도 예약은 1,000원 이하: 400원 → 최대 2회 = 800원, 600원 → 1회
  assert.equal(withRecovery(script(['ok'], 400).m, { maxAttempts: 3 }).costPerCallKrw, 800);
  assert.equal(withRecovery(script(['ok'], 600).m, { maxAttempts: 3 }).costPerCallKrw, 600);
  assert.equal(withRecovery(script(['ok'], 5).m, { maxAttempts: 3 }).costPerCallKrw, 15);
  assert.equal(withRecovery(script(['ok'], 0).m, { maxAttempts: 3 }).costPerCallKrw, 0);
});

test('RC8 차단기: 연속 실패하면 즉시 안전 전환(모델 호출 0회·예약 취소 0원), 시간이 지나면 시험 1회로 복구', async () => {
  let t = 1000;
  const mk = (steps: Step[]) => script(steps, 5);
  const s = mk(['server', 'server', 'server', 'server', 'server', 'server', 'ok']);
  const w = withRecovery(s.m, { now: () => t, sleep: async () => {}, maxAttempts: 2, breakerFailures: 3, breakerOpenMs: 30_000 });
  for (let i = 0; i < 3; i++) await assert.rejects(w.generate(IN, sig()), ModelCallError); // 실패 3 요청 = 호출 6회
  assert.equal(s.st.calls, 6);
  // 열림: 호출 0회, ModelNotCalledError(=예약 취소)
  await assert.rejects(w.generate(IN, sig()), ModelNotCalledError);
  assert.equal(s.st.calls, 6);
  const rows: string[] = [];
  const budget: AiBudget = { async reserve(c) { rows.push('R' + c); return { async confirm(a) { rows.push('C' + a); }, async cancel() { rows.push('X'); } }; } };
  const r = await answerChat(deps({ budget, model: w }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback' && r.text.includes('11,111'));
  assert.deepEqual(rows, ['R10', 'X']);
  assert.equal(s.st.calls, 6);
  // 30초 뒤 반열림: 시험 호출은 1회만(7번째 = server 실패라면 다시 열림)
  t += 30_001;
  const probeFail = mk(['server']);
  const w2 = withRecovery(probeFail.m, { now: () => t, sleep: async () => {}, breakerFailures: 1, breakerOpenMs: 30_000 });
  await assert.rejects(w2.generate(IN, sig()), ModelCallError); // 열림
  await assert.rejects(w2.generate(IN, sig()), ModelNotCalledError);
  t += 30_001;
  await assert.rejects(w2.generate(IN, sig()), ModelCallError); // 시험 1회 실패 → 다시 열림
  assert.equal(probeFail.st.calls, 3); // 열릴 때까지 2회 + 시험 1회
  await assert.rejects(w2.generate(IN, sig()), ModelNotCalledError);
  // 시험 성공이면 닫힘 → 정상 상담 재개
  t += 30_001;
  const w3src = mk(['server', 'ok']);
  const w3 = withRecovery(w3src.m, { now: () => t, sleep: async () => {}, maxAttempts: 1, breakerFailures: 1, breakerOpenMs: 30_000 });
  await assert.rejects(w3.generate(IN, sig()), ModelCallError);
  await assert.rejects(w3.generate(IN, sig()), ModelNotCalledError);
  t += 30_001;
  assert.ok((await w3.generate(IN, sig())).includes('11,111')); // 시험 성공
  assert.ok((await w3.generate(IN, sig())).includes('11,111')); // 닫힘 유지
});

test('RC8b 반열림 시험 중 동시 요청은 호출하지 않는다(시험은 1개만)', async () => {
  let t = 0;
  let release: (v: string) => void = () => {};
  let calls = 0;
  const m: ChatModel = { name: 'p', costPerCallKrw: 0, generate() { calls++; if (calls === 1) throw err('server'); return new Promise<string>((res) => { release = res; }); } };
  const w = withRecovery(m, { now: () => t, sleep: async () => {}, maxAttempts: 1, breakerFailures: 1, breakerOpenMs: 1000 });
  await assert.rejects(w.generate(IN, sig()), ModelCallError); // 열림
  t += 1001;
  const probe = w.generate(IN, sig()); // 시험 시작(대기 중)
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  await assert.rejects(w.generate(IN, sig()), ModelNotCalledError); // 동시 요청은 호출 0
  assert.equal(calls, 2);
  release('복구됨');
  assert.equal(await probe, '복구됨');
  assert.equal(calls, 2);
});

test('RC9 계속 실패(429·5xx·네트워크·timeout)해도 고객에게는 승인 안내문만: 가격 지어내기·오류 문구·키 노출 없음, 복구되면 모델 답변', async () => {
  const baseline = await answerChat(deps(), input(), NOW); // 모델 없음 = 승인 안내문
  assert.ok(baseline.ok && baseline.source === 'fallback' && baseline.text.includes('11,111'));
  const T = (seq: ('429' | '500' | 'net' | 'hang' | 'ok')[]) => {
    let i = 0;
    const calls = { n: 0 };
    const t: BodyTransport = async (_u, init) => {
      calls.n++;
      const approved = (/\[승인 안내문\]\\n([\s\S]*?)\\n\\n\[고객 문의/.exec(new TextDecoder().decode(init.body)) ?? [])[1] ?? '';
      const s = seq[Math.min(i++, seq.length - 1)]!;
      if (s === 'hang') return new Promise(() => {});
      if (s === 'net') throw new Error('network ' + KEY);
      if (s === 'ok') return { status: 200, body: new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n' + JSON.parse('"' + approved + '"') }] }] })).body };
      return { status: s === '429' ? 429 : 503, body: new Response('{"error":"월 9,900원 ' + KEY + '"}').body };
    };
    return { t, calls };
  };
  const model = (t: BodyTransport) => withRecovery(createOpenAiChatModel({ transport: t, endpoint: 'https://model.example.test/v1/responses', apiKey: KEY, model: 'test-model', executionAllowed: true, costPerCallKrw: 5, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192, prices: [{ model: 'test-model', currency: 'KRW', inputKrwPerMTok: 100, outputKrwPerMTok: 400 }], maxInputTokens: 4000 }), { ...fast, sleep: async () => {} });
  for (const [name, seq] of [['429', ['429']], ['5xx', ['500']], ['network', ['net']], ['timeout', ['hang']]] as const) {
    const x = T([...seq]);
    const r = await answerChat(deps({ model: model(x.t), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }), timeoutMs: 5000 }), input(), NOW);
    assert.ok(r.ok && r.source === 'fallback', name);
    assert.equal(r.ok && r.text, baseline.ok && baseline.text, name); // 승인 안내문 그대로
    const dump = JSON.stringify(r);
    assert.ok(!dump.includes('9,900') && !dump.includes(KEY) && !/HTTP|TIMEOUT|TRANSPORT|sk-/.test(dump), name);
    assert.equal(x.calls.n, 2, name); // 기본 최대 2회
    // 일시 장애: 첫 시도 실패 → 자동 재시도 성공 = 모델 답변
    const y = T([...seq, 'ok']);
    const r2 = await answerChat(deps({ model: model(y.t), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }), timeoutMs: 5000 }), input(), NOW);
    assert.ok(r2.ok && r2.source === 'model' && r2.text.includes('11,111'), name);
    assert.equal(y.calls.n, 2, name);
  }
});

test('RC10 상담 전체 시간 상한: 어떤 설정도 10초 초과 불가, 바깥 취소 뒤에는 더 시도하지 않는다', async () => {
  assert.deepEqual([chatTimeoutMs(undefined), chatTimeoutMs(Number.NaN), chatTimeoutMs(-1), chatTimeoutMs(0), chatTimeoutMs(20), chatTimeoutMs(99_999_999), chatTimeoutMs(Infinity)], [8000, 8000, 8000, 8000, 20, 10_000, 8000]);
  const { m, st } = script(['hang']);
  const ac = new AbortController();
  const w = withRecovery(m, { sleep: async () => {}, attemptMs: 5000 });
  const p = w.generate(IN, ac.signal).catch((e: unknown) => e);
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const e = await p;
  assert.ok(e instanceof ModelCallError);
  assert.equal(st.calls, 1); // 취소 뒤 재시도 없음
  // 상담 전체 시간(20ms) 안에서 끝나고 안전 안내문
  const slow = script(['hang'], 5);
  const t0 = Date.now();
  const r = await answerChat(deps({ timeoutMs: 40, model: withRecovery(slow.m, { sleep: async () => {} }), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' }) }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback' && Date.now() - t0 < 1500);
  assert.equal(slow.st.calls, 1);
});

test('RC11 중복 방어: 처리 중인 같은 세션 요청은 BUSY(모델 1회), 끝나면 다음 요청 정상, 실패 뒤에도 잠금이 풀려 상담 재개', async () => {
  const KEYB = Buffer.alloc(32, 7);
  let release: (v: string) => void = () => {};
  let calls = 0;
  let approvedNow = '';
  let mode: 'slow' | 'fail' | 'ok' = 'slow';
  const model: ChatModel = {
    name: 'g', costPerCallKrw: 0,
    generate(i) {
      calls++;
      approvedNow = i.approved;
      if (mode === 'slow') return new Promise<string>((res) => { release = res; });
      if (mode === 'fail') return Promise.reject(err('server'));
      return Promise.resolve('문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n' + approvedNow);
    },
  };
  const post = (b: unknown) => new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(b) });
  const good = { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?' };
  const guard = createInflightGuard();
  const HD = (over: Record<string, unknown> = {}) => ({ enabled: true, chat: deps({ model }), limiter: createLimiter(99, 60_000), ip: '203.0.113.9', now: () => NOW, sessionKey: KEYB, newSessionLimiter: createLimiter(99, 60_000), botCheck: async () => 'ok', rateLimit: async () => true, inflight: guard, ...over }) as never;
  // 첫 요청(새 세션)으로 서명 세션을 받는다
  mode = 'ok';
  const r0 = await handleChat(post(good), HD());
  assert.equal(r0.status, 200);
  const tok = (await r0.json()).session as string;
  const calls0 = calls;
  // 느린 요청이 처리 중일 때 같은 세션 연타
  mode = 'slow';
  const first = handleChat(post({ ...good, session: tok }), HD());
  await new Promise((r) => setImmediate(r));
  const dup1 = await handleChat(post({ ...good, session: tok }), HD());
  const dup2 = await handleChat(post({ ...good, session: tok }), HD());
  assert.deepEqual([dup1.status, (await dup1.json()).code, dup2.status], [429, 'BUSY', 429]);
  assert.equal(calls - calls0, 1); // 중복 AI 호출 0
  release('문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n' + approvedNow);
  assert.equal((await first).status, 200);
  // 실패(모델 5xx) 중에도 안전 안내문으로 200, 잠금 해제 → 다음 요청 처리
  mode = 'fail';
  const failed = await handleChat(post({ ...good, session: tok }), HD());
  const fj = await failed.json();
  assert.ok(failed.status === 200 && fj.source === 'fallback' && fj.text.includes('11,111') && !JSON.stringify(fj).includes('HTTP_ERROR'));
  mode = 'ok';
  const back = await handleChat(post({ ...good, session: tok }), HD());
  const bj = await back.json();
  assert.ok(back.status === 200 && bj.source === 'model');
  // 다른 세션·다른 IP는 영향 없음, 오래 걸려 남은 잠금은 ttl 뒤 풀림
  const g2 = createInflightGuard(1000);
  assert.equal(g2.enter('s:a', 0), true);
  assert.equal(g2.enter('s:a', 500), false);
  assert.equal(g2.enter('s:b', 500), true);
  assert.equal(g2.enter('s:a', 1001), true);
  g2.leave('s:a');
  assert.equal(g2.enter('s:a', 1002), true);
});

test('RC12 복구 후 정상 재개(요청 흐름 전체): 장애 → 차단 → 시간 경과 → 모델 답변 복귀', async () => {
  let t = 5000;
  const s = script(['server', 'server', 'server', 'ok'], 0);
  const w = withRecovery(s.m, { now: () => t, sleep: async () => {}, maxAttempts: 1, breakerFailures: 2, breakerOpenMs: 10_000 });
  const ask = () => answerChat(deps({ model: w }), input(), NOW);
  const a = await ask(), b = await ask();
  assert.ok(a.ok && b.ok && a.source === 'fallback' && b.source === 'fallback');
  const c = await ask(); // 차단 중 → 호출 없이 안내문
  assert.ok(c.ok && c.source === 'fallback' && c.text.includes('11,111'));
  assert.equal(s.st.calls, 2);
  t += 10_001;
  const d = await ask(); // 시험 호출(3번째 단계 = server 실패) → 다시 열림
  assert.ok(d.ok && d.source === 'fallback');
  t += 10_001;
  const e = await ask(); // 시험 호출 성공
  assert.ok(e.ok && e.source === 'model');
  const f = await ask();
  assert.ok(f.ok && f.source === 'model');
});

test('RC13 정적: 서버 상한·클라이언트 timeout·중복 잠금·무한 반복 없음, 상담 경로에는 복구 래퍼만 연결', () => {
  const rd = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const rcv = rd('src/server/consult/modelRecovery.ts');
  assert.ok(!/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/.test(rcv), '무한 반복 금지');
  assert.ok(/RECOVERY_LIMITS/.test(rcv) && /clampInt/.test(rcv));
  assert.ok(!/process\.env|fetch\(|https?:\/\//.test(rcv.replace(/\/\/.*$/gm, '')), '환경·네트워크·주소 없음');
  const ui = rd('src/components/ConsultAiChat.tsx');
  assert.ok(/AbortController/.test(ui) && /CLIENT_TIMEOUT_MS/.test(ui) && /sending\.current/.test(ui), '브라우저 timeout·동기 잠금');
  assert.ok(!/setInterval|while\s*\(/.test(ui) && (ui.match(/fetch\(/g) ?? []).length === 1, '브라우저 자동 재시도 없음');
  assert.ok(/guard\.leave\(key\)/.test(rd('src/server/consult/chatHandler.ts')), '잠금은 finally에서 해제');
  assert.ok(/recoveringModelFor\(process\.env\.CONSULT_AI_PROVIDER === 'gemini-free' \? geminiFreeModelFromEnv\(process\.env, geminiFetchTransport\) : consultModelFromEnv\(process\.env, openAiFetchTransport\), CONSULT_RECOVERY_TIMING\)/.test(rd('src/app/api/consult/chat/route.ts')));
  // 같은 모델 객체는 같은 복구 상태(차단기)를 쓴다
  const m = script(['ok']).m;
  assert.equal(recoveringModelFor(m), recoveringModelFor(m));
  assert.equal(recoveringModelFor(null), null);
  // 미터: 복구 래퍼를 거치지 않는 모델은 meter를 올리지 않아 예약 전액 확정(보수적)
  const meter: CallMeter = { sent: 0 };
  void meter;
});

const cfgR = (t: BodyTransport, over: Partial<OpenAiChatModelConfig> = {}): OpenAiChatModelConfig => ({ transport: t, endpoint: 'https://model.example.test/v1/responses', apiKey: KEY, model: 'test-model', executionAllowed: true, costPerCallKrw: 5, maxOutputTokens: 200, timeoutMs: 5000, maxResponseBytes: 8192, prices: [{ model: 'test-model', currency: 'KRW', inputKrwPerMTok: 100, outputKrwPerMTok: 400 }], maxInputTokens: 4000, ...over });
const okBody = (approved = '월 11,111원') => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '현재 확인된 안내입니다.\n' + approved }] }] });

test('RC14 Retry-After: 정수 초만 인정, 우리 대기 상한(2초) 안이면 그만큼 기다리고, 넘으면 재시도 없이 즉시 안내문', async () => {
  const tr = (calls: { n: number }, ra: string | null, then: 'ok' | 'again'): BodyTransport => async () => {
    calls.n++;
    if (calls.n === 1 || then === 'again') return { status: 429, body: null, headers: new Headers(ra === null ? {} : { 'retry-after': ra }) };
    return { status: 200, body: new Response(okBody()).body };
  };
  const run = async (ra: string | null, then: 'ok' | 'again' = 'ok') => {
    const calls = { n: 0 }; const s = noSleep();
    const w = withRecovery(createOpenAiChatModel(cfgR(tr(calls, ra, then))), { ...s, baseDelayMs: 100, maxDelayMs: 2000, maxAttempts: 2 });
    const out = await w.generate(IN, sig(), permit()).catch((e: unknown) => e);
    return { out, calls: calls.n, delays: s.delays };
  };
  const a = await run('1'); // 1초 → 대기 1000ms 후 재시도 성공
  assert.ok(typeof a.out === 'string' && a.calls === 2 && a.delays[0] === 1000, JSON.stringify(a));
  const b = await run('30', 'again'); // 30초 > 2초 상한 → 재시도 없이 실패(호출 1회)
  assert.ok(b.out instanceof ModelCallError && b.out.retryAfterMs === 30_000 && b.calls === 1 && b.delays.length === 0);
  for (const bad of ['Wed, 21 Oct 2026 07:28:00 GMT', '-5', '0', '1.5', '99999', 'abc', '']) {
    const r = await run(bad); // 형식 밖은 무시: 기본 대기(100ms)로 재시도
    assert.ok(typeof r.out === 'string' && r.delays[0] === 100, bad);
  }
  const none = await run(null);
  assert.ok(typeof none.out === 'string' && none.delays[0] === 100);
  // 429가 아닌 5xx의 Retry-After도 같은 규칙, 2xx의 Retry-After는 읽지 않는다(오류 어댑터 경로 아님)
  const e = await createOpenAiChatModel(cfgR(async () => ({ status: 503, body: null, headers: new Headers({ 'retry-after': '2' }) }))).generate(IN, sig(), permit()).catch((x: unknown) => x);
  assert.ok(e instanceof ModelCallError && e.kind === 'server' && e.retryAfterMs === 2000 && !e.message.includes('2'));
});

test('RC15 실제 취소: 시도 시간 초과·바깥 취소 때 진행 중인 HTTP 요청의 신호가 취소된다(마감까지 붙들지 않음)', async () => {
  const signals: AbortSignal[] = [];
  const hang: BodyTransport = (_u, init) => { signals.push(init.signal); return new Promise(() => {}); };
  const w = withRecovery(createOpenAiChatModel(cfgR(hang, { timeoutMs: 15000 })), { maxAttempts: 2, attemptMs: 40, baseDelayMs: 1, sleep: async () => {} });
  const t0 = Date.now();
  await assert.rejects(w.generate(IN, sig(), permit()), ModelCallError);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s.aborted), '시도 제한 뒤 요청 신호 취소');
  assert.ok(Date.now() - t0 < 1500); // 15초 마감을 기다리지 않음
  // 바깥(상담 전체) 취소
  signals.length = 0;
  const ac = new AbortController();
  const w2 = withRecovery(createOpenAiChatModel(cfgR(hang, { timeoutMs: 15000 })), { attemptMs: 5000, sleep: async () => {} });
  const p = w2.generate(IN, ac.signal, permit()).catch((x: unknown) => x);
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  assert.ok((await p) instanceof ModelCallError);
  assert.equal(signals.length, 1);
  assert.ok(signals[0]!.aborted);
});
