// AI 비용 하드 한도 보강(0025, PM 11/24 A·B·C) — 앱 경로 Mock 시험. 실제 AI·운영 DB 호출 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerChat, requestFingerprint } from '../../src/server/consult/chatAnswer';
import { createAiBudget, createDbAiBudget, ModelNotCalledError } from '../../src/server/consult/chatModel';
import type { AiBudget, ChatModel, ModelInput } from '../../src/server/consult/chatModel';
import { handleChat } from '../../src/server/consult/chatHandler';

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
const KEY = 'req-0000-0000-0000-0001';
const input = (over: Record<string, unknown> = {}) => ({ message: '요금이 얼마예요?', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', ...over });
const deps = (model: ChatModel, budget: AiBudget, timeoutMs?: number) => ({ provider: () => [rec], supplierId: 'supplier-a', model, budget, timeoutMs }) as never;
const counting = (impl: (i: ModelInput, s: AbortSignal) => Promise<string>, cost = 50) => {
  const m = { calls: 0, model: null as unknown as ChatModel };
  m.model = { name: 'fake', costPerCallKrw: cost, generate: async (i, s) => { m.calls++; return impl(i, s); } };
  return m;
};
const OK = async () => '문의 주셔서 감사합니다.';

test('HC1 같은 요청 키 재시도 100회 → 예약 1회·AI 호출 1회, 나머지는 안전 안내(메모리 예산)', async () => {
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100000' });
  const m = counting(OK);
  const rs = await Promise.all(Array.from({ length: 100 }, () => answerChat(deps(m.model, b), input({ requestKey: KEY }), NOW)));
  assert.equal(m.calls, 1);
  assert.equal(rs.filter((r) => r.ok && r.source === 'model').length, 1);
  assert.ok(rs.every((r) => r.ok));
});
test('HC2 DB 예산: 키·내용 지문을 hold_keyed에 바인딩으로 전달, reserved가 아니면(id null) AI 호출 0회', async () => {
  const log: string[] = [];
  const db = (id: unknown) => createDbAiBudget(async (fn) => fn(((s: TemplateStringsArray, ...v: unknown[]) => { log.push(s.join('?') + '|' + v.join(',')); return Promise.resolve([{ id }]); }) as never));
  const m = counting(OK);
  await answerChat(deps(m.model, db('9')), input({ requestKey: KEY }), NOW);
  assert.equal(m.calls, 1);
  assert.ok(log[0].includes('api.ai_budget_hold_keyed(') && new RegExp(`\\|50,${KEY},[0-9a-f]{64}$`).test(log[0]), log[0]);
  for (const outcomeNull of [null, undefined]) { // replay·conflict·한도·잠금은 DB가 hold_id null
    const m2 = counting(OK);
    const r = await answerChat(deps(m2.model, db(outcomeNull)), input({ requestKey: KEY }), NOW);
    assert.equal(m2.calls, 0);
    assert.ok(r.ok && r.source === 'fallback');
  }
  // 키 없는 요청은 null 키로(멱등 없음), 형식 밖 키는 무시
  log.length = 0;
  await answerChat(deps(counting(OK).model, db('10')), input({ requestKey: 'bad key!' }), NOW);
  assert.ok(log[0].endsWith('50,,'), log[0]);
});
test('HC3 내용 지문: 같은 내용은 같고, 글·상품·지역이 다르면 다름(같은 키·다른 내용 = DB 충돌). 원문 전화번호는 지문에 안 들어감', async () => {
  const a = requestFingerprint('요금이 얼마예요?', input());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, requestFingerprint('요금이 얼마예요?', input()));
  assert.notEqual(a, requestFingerprint('다른 질문', input()));
  for (const o of [{ productId: 'other' }, { regionCode: 'region-2' }, { carrier: 'carrier-y' }]) assert.notEqual(a, requestFingerprint('요금이 얼마예요?', input(o)));
  // 번호만 다른 두 글은 가린 뒤 같은 글 → 같은 지문(원문 번호의 해시가 DB로 가지 않는다)
  const hashes: string[] = [];
  const b: AiBudget = { async reserve(_c, req) { if (req) hashes.push(req.hash); return null; } };
  for (const phone of ['010-1234-5678', '010-9876-5432']) await answerChat(deps(counting(OK).model, b), input({ message: `연락처 ${phone} 요금 알려주세요`, requestKey: KEY }), NOW);
  assert.ok(hashes.length === 0 || (hashes.length === 2 && hashes[0] === hashes[1]), JSON.stringify(hashes));
});
test('HC4 형식 밖 키를 예산에 직접 넘기면 DB 0회·거부', async () => {
  let n = 0;
  const db = createDbAiBudget(async () => { n++; return [{ id: '1' }] as never; });
  for (const req of [{ key: 'short', hash: 'a'.repeat(64) }, { key: KEY, hash: 'zz' }, { key: KEY, hash: 'A'.repeat(64) }]) assert.equal(await db.reserve(5, req), null);
  assert.equal(n, 0);
  assert.equal(await createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' }).reserve(5, { key: 'x', hash: 'y' }), null);
});
test('HC5 메모리 예산: 한도로 거부된 키는 소비되지 않고, 동시 100건(한도 1000·30원)은 33건만', async () => {
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' });
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => b.reserve(30, { key: `k-${String(i).padStart(16, '0')}`, hash: 'a'.repeat(64) })));
  assert.equal(rs.filter(Boolean).length, 33);
  const small = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '10' });
  assert.equal(await small.reserve(20, { key: KEY, hash: 'b'.repeat(64) }), null);
  assert.ok(await createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' }).reserve(20, { key: KEY, hash: 'b'.repeat(64) }));
});
test('HC6 DB 장애(Fail-Closed): 예약 쿼리 예외·이상 값 → AI 호출 0회, 고객에게는 승인 안내문', async () => {
  for (const run of [async () => { throw new Error('ECONNREFUSED'); }, async () => [{ id: 'abc' }], async () => [], async () => null]) {
    const m = counting(OK);
    const r = await answerChat(deps(m.model, createDbAiBudget(run as never)), input({ requestKey: KEY }), NOW);
    assert.equal(m.calls, 0);
    assert.ok(r.ok && r.source === 'fallback' && !/ECONN|error/i.test(r.text));
  }
});
test('HC7 타임아웃·응답 오류는 예약 전액 확정, 요청 전 실패만 0원 취소', async () => {
  const spy = () => { const log: string[] = []; const b: AiBudget = { async reserve(c) { log.push(`reserve:${c}`); return { async confirm(a) { log.push(`confirm:${a}`); }, async cancel() { log.push('cancel'); } }; } }; return { b, log }; };
  const t = spy();
  await answerChat(deps(counting((_, sig) => new Promise((_, rej) => sig.addEventListener('abort', () => rej(new Error('aborted'))))).model, t.b, 30), input(), NOW);
  assert.deepEqual(t.log, ['reserve:50', 'confirm:50']);
  const e = spy();
  await answerChat(deps(counting(async () => { throw new Error('500'); }).model, e.b), input(), NOW);
  assert.deepEqual(e.log, ['reserve:50', 'confirm:50']);
  const n = spy();
  await answerChat(deps(counting(async () => { throw new ModelNotCalledError('NOT_CONFIGURED'); }).model, n.b), input(), NOW);
  assert.deepEqual(n.log, ['reserve:50', 'cancel']);
});
test('HC8 요청 핸들러: requestId(선택)는 형식 검사 후 answerChat에 전달, 형식 밖이면 400·모델 0회', async () => {
  const seen: unknown[] = [];
  const m = counting(async (i) => { seen.push(i); return '문의 주셔서 감사합니다.'; });
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' });
  const base = {
    enabled: true, chat: { provider: () => [rec], supplierId: 'supplier-a', model: m.model, budget: b },
    sessionKey: Buffer.alloc(32, 7), newSessionLimiter: () => true, limiter: () => true, ip: '203.0.113.9', now: () => NOW,
    botCheck: async () => 'ok' as const, rateLimit: async () => true,
  } as never;
  const post = (body: unknown) => handleChat(new Request('https://x.test/api/consult/chat', { method: 'POST', body: JSON.stringify(body) }), base);
  for (const bad of ['short', 'has space 000000000000', 123, null]) {
    const r = await post({ carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?', turnstileToken: 't', requestId: bad });
    assert.equal(r.status, 400);
  }
  assert.equal(m.calls, 0);
  const r1 = await post({ carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금이 얼마예요?', turnstileToken: 't', requestId: KEY });
  const j1 = await r1.json() as { ok: boolean; source: string; session: string };
  assert.equal(r1.status, 200);
  assert.equal(j1.source, 'model');
  // 같은 키 재전송(같은 세션) → 새 예약·호출 없음
  const r2 = await post({ carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금이 얼마예요?', session: j1.session, requestId: KEY });
  const j2 = await r2.json() as { ok: boolean; source: string };
  assert.equal(r2.status, 200);
  assert.equal(j2.source, 'fallback');
  assert.equal(m.calls, 1);
});
