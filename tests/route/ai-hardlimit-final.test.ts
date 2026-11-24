// PM 11/24 AI 비용 하드 한도 최종검증 — 앱 쪽 B4(예약 초과 확정 차단)·B7(클라이언트가 비용·한도를 바꾸지 못함). 실제 AI 호출 0회.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiBudget, createDbAiBudget, type AiBudget, type ReserveContext } from '../../src/server/consult/chatModel';
import { createInflightGuard, createLimiter, handleChat } from '../../src/server/consult/chatHandler';

const ctx = (n: number): ReserveContext => ({ requestId: `req-final-${String(n).padStart(12, '0')}`, scope: 'a'.repeat(64) });

test('FL1 메모리 예산: 10원 예약 뒤 900원 확정 시도 → 10원으로만 셈(예약 초과 0), 한도 100원 정확히 지킴', async () => {
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' });
  const h = await b.reserve(10, ctx(1));
  await h!.confirm(900);
  await h!.confirm(5); // 이중 확정은 반영 안 됨
  assert.ok(await b.reserve(90, ctx(2)), '10 + 90 = 100 허용');
  assert.equal(await b.reserve(1, ctx(3)), null, '100원 도달 뒤 1원 거부(900원이 반영됐다면 이미 거부)');
});

test('FL2 DB 예산: 확정 금액은 예약 금액 이하로만 보낸다(DB 0030도 초과 거부), 0·NaN은 1원·예약 전액', async () => {
  const sent: unknown[][] = [];
  const b = createDbAiBudget(async (fn) => fn(((s: TemplateStringsArray, ...v: unknown[]) => { sent.push([s.join('?'), ...v]); return Promise.resolve(s.join('?').includes('hold') ? [{ id: '7' }] : [{}]); }) as never));
  for (const [actual, want] of [[900, 10], [11, 10], [7, 7], [0, 1], [Number.NaN, 10]] as const) {
    sent.length = 0;
    const h = await b.reserve(10, ctx(10 + want));
    await h!.confirm(actual);
    const c = sent.find((x) => String(x[0]).includes('ai_budget_confirm'))!;
    assert.equal(c[2], want, `confirm(${actual}) → ${want}`);
  }
});

test('FL3 클라이언트는 비용·한도를 바꾸지 못함: 비용·한도·사용자 키 필드가 붙으면 400(예약 0건), 예약 비용은 서버 모델 값, 사용자 키는 서버 HMAC', async () => {
  const seen: { cost: number; scope?: string }[] = [];
  const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' });
  const budget: AiBudget = { async reserve(c, x) { seen.push({ cost: c, scope: x?.scope }); return inner.reserve(c, x); } };
  const model = { name: 'f', costPerCallKrw: 4, async generate(i: { approved: string }) { return `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${i.approved}`; } };
  const K = <T,>(value: T) => ({ known: true as const, value });
  const rec = {
    supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
    sourceKind: 'official_policy_sheet', reviewStatus: 'approved', confirmedAt: '2026-11-23T09:00:00+09:00', validFrom: '2026-11-23T00:00:00+09:00', validUntil: K('2026-11-24T00:00:00+09:00'),
    monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36), equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
    bundlePrerequisites: K([]), regionScope: K('nationwide'),
    customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
    internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
  };
  const HD = () => ({ enabled: true, chat: { provider: () => [rec], supplierId: 'supplier-a', model, budget, failureLog: () => {} }, limiter: createLimiter(1000, 60_000), ip: '203.0.113.9', now: () => new Date('2026-11-23T12:00:00+09:00'), sessionKey: Buffer.alloc(32, 7), newSessionLimiter: createLimiter(1000, 60_000), botCheck: async () => 'ok', rateLimit: async () => true, inflight: createInflightGuard() }) as never;
  const post = (x: unknown) => handleChat(new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(x) }), HD());
  const good = { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?' };
  for (const extra of [{ costKrw: 0 }, { costPerCallKrw: 0 }, { limit: 999999 }, { budget: 999999 }, { scope: 'f'.repeat(64) }, { dailyLimitKrw: 1 }]) {
    const r = await post({ ...good, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal(seen.length, 0, '비용·한도·사용자 키 필드가 붙은 요청은 예약 전 거부(허용 필드 고정)');
  await post({ ...good, requestId: 'req-final-client-000001' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.cost, 4, '예약 비용 = 서버 모델 값');
  assert.match(seen[0]!.scope!, /^[0-9a-f]{64}$/, '사용자 키 = 서버 HMAC');
});
