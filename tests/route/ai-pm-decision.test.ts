// PM 11/24 최종 결정 반영 시험 — ② 비용 계산용 환율·공식 단가 기록, ③ 사용자별 한도 키 = 서명 세션(IP 단독 금지). 실제 AI 호출 0회.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { COST_ESTIMATE_FX_KRW_PER_USD, estimateMaxKrw, krwPriceFromUsd, priceFor } from '../../src/server/ai/costModel';
import { VERIFIED_USD_PRICES, verifiedKrwPrices } from '../../src/server/ai/verifiedPrices';
import { createOpenAiChatModel } from '../../src/server/consult/openAiChatModel';
import { createAiBudget, grantBudgetPermit, ModelNotCalledError, type AiBudget, type ReserveContext } from '../../src/server/consult/chatModel';
import { aiScopeFor, createInflightGuard, createLimiter, handleChat } from '../../src/server/consult/chatHandler';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const LUNA = { model: 'gpt-5.6-luna', inputMicroUsdPerMTok: 200_000, cachedInputMicroUsdPerMTok: 20_000, outputMicroUsdPerMTok: 1_200_000 };

test('PD1 환율 변환: 1,800원/USD(1,500원 + 20%), 원 단위 올림 — 입력 360·캐시 36·출력 2,160원/백만 토큰', () => {
  assert.equal(COST_ESTIMATE_FX_KRW_PER_USD, 1800);
  assert.equal(COST_ESTIMATE_FX_KRW_PER_USD, Math.round(1500 * 1.2));
  assert.deepEqual(krwPriceFromUsd(LUNA), { model: 'gpt-5.6-luna', currency: 'KRW', inputKrwPerMTok: 360, outputKrwPerMTok: 2160, cachedInputKrwPerMTok: 36 });
  assert.equal(krwPriceFromUsd({ model: 'm', inputMicroUsdPerMTok: 1, outputMicroUsdPerMTok: 1 })!.inputKrwPerMTok, 1, '1마이크로달러도 1원으로 올림(내림 없음)');
  assert.equal(krwPriceFromUsd({ model: 'm', inputMicroUsdPerMTok: 555_556, outputMicroUsdPerMTok: 0 })!.inputKrwPerMTok, 1001, '0.555556×1,800 = 1,000.0008 → 1,001');
});

test('PD2 이상 값은 가격 없음(null = 호출 금지): 음수·소수·과대·캐시 > 입력·환율 이상, KRW 외 통화 직접 입력도 거부', () => {
  for (const bad of [{ ...LUNA, inputMicroUsdPerMTok: -1 }, { ...LUNA, outputMicroUsdPerMTok: 0.5 }, { ...LUNA, inputMicroUsdPerMTok: 2e9 }, { ...LUNA, cachedInputMicroUsdPerMTok: 300_000 }, { ...LUNA, model: '' }]) {
    assert.equal(krwPriceFromUsd(bad as never), null, JSON.stringify(bad));
  }
  for (const fx of [0, -1, 1800.5, Number.NaN, 1e9]) assert.equal(krwPriceFromUsd(LUNA, fx), null, String(fx));
  assert.equal(priceFor([{ model: 'gpt-5.6-luna', currency: 'USD', inputKrwPerMTok: 0, outputKrwPerMTok: 1 }], 'gpt-5.6-luna'), null);
});

test('PD3 공식 확인 기록: gpt-5.6-luna 출처·확인일 있음, 원화 가격표로 1회 최대 2원(입력 4,000·출력 200토큰), 출처·확인일 없으면 제외', () => {
  assert.equal(VERIFIED_USD_PRICES.length, 1);
  const v = VERIFIED_USD_PRICES[0]!;
  assert.match(v.sourceUrl, /^https:\/\/developers\.openai\.com\/api\/docs\/models\/gpt-5\.6-luna$/);
  assert.equal(v.verifiedOn, '2026-11-24');
  const t = verifiedKrwPrices();
  const p = priceFor(t, 'gpt-5.6-luna')!;
  assert.deepEqual([p.inputKrwPerMTok, p.outputKrwPerMTok, p.cachedInputKrwPerMTok], [360, 2160, 36]);
  assert.equal(estimateMaxKrw(p, 4000, 200), 2, '(4,000×360 + 200×2,160)/100만 = 1.872 → 2원');
  assert.equal(priceFor(t, 'gpt-5.6-terra'), null, '기록 없는 모델 = 가격 불확실');
  assert.deepEqual(verifiedKrwPrices([{ ...v, sourceUrl: '' }]), []);
  assert.deepEqual(verifiedKrwPrices([{ ...v, verifiedOn: 'today' }]), []);
});

test('PD4 단가 미확인 모델은 호출 차단(전송 0회), 기록은 가격표 연결 1곳(consultModelFromEnv)에서만 쓰고 실제 전송은 없음', async () => {
  let calls = 0;
  const t: BodyTransport = async () => { calls++; throw new Error('must not send'); };
  const m = createOpenAiChatModel({ transport: t, endpoint: 'https://model.example.test/v1/responses', apiKey: 'sk-test-' + 'A'.repeat(30), model: 'gpt-5.6-terra', executionAllowed: true, costPerCallKrw: 2, maxOutputTokens: 200, timeoutMs: 5000, maxResponseBytes: 8192, prices: verifiedKrwPrices(), maxInputTokens: 4000 });
  const meter = { sent: 0 }; grantBudgetPermit(meter);
  await assert.rejects(m.generate({ system: 'S', user: 'u', approved: 'a' }, new AbortController().signal, meter), ModelNotCalledError);
  assert.equal(calls, 0);
  // 정적: 확인 기록은 상담 모델 선택 1곳에서만 import(라우트·핸들러 직접 사용 없음), 환율이 청구 환율이 아니라는 표시 유지
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(n)) files.push(f); } };
  walk('src');
  assert.deepEqual(files.filter((f) => /from ['"][^'"]*verifiedPrices['"]/.test(readFileSync(f, 'utf8'))), [path.join('src', 'server', 'consult', 'openAiChatModel.ts')]);
  assert.match(readFileSync('src/server/ai/costModel.ts', 'utf8'), /실제 청구 환율 아님/);
  assert.match(readFileSync('src/server/consult/chatModel.ts', 'utf8'), /CONSULT_AI_MODEL === 'mock' \? mockModel : null/, 'createModel은 여전히 mock뿐');
});

// ───── ③ 사용자별 한도 키 ─────
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
const SKEY = Buffer.alloc(32, 7);
const IP = '203.0.113.9';

test('PD5 사용자 키 = 서명 세션 HMAC: 같은 IP라도 세션마다 다르고, 같은 세션은 같다. IP 해시·원문 세션 ID·IP와 다르다', async () => {
  const ctxs: ReserveContext[] = [];
  const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' });
  const budget: AiBudget = { async reserve(c, ctx) { if (ctx) ctxs.push(ctx); return inner.reserve(c, ctx); } };
  const model = { name: 'f', costPerCallKrw: 1, async generate(i: { approved: string }) { return `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${i.approved}`; } };
  const HD = () => ({ enabled: true, chat: { provider: () => [rec], supplierId: 'supplier-a', model, budget, failureLog: () => {} }, limiter: createLimiter(1000, 60_000), ip: IP, now: () => NOW, sessionKey: SKEY, newSessionLimiter: createLimiter(1000, 60_000), botCheck: async () => 'ok', rateLimit: async () => true, inflight: createInflightGuard() }) as never;
  const post = (b: unknown) => new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(b) });
  const good = { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?' };
  const a = await (await handleChat(post(good), HD())).json() as { session: string };
  const b = await (await handleChat(post(good), HD())).json() as { session: string };
  await handleChat(post({ ...good, session: a.session }), HD());
  assert.equal(ctxs.length, 3);
  const [sa, sb, sa2] = ctxs.map((c) => c.scope);
  assert.match(sa!, /^[0-9a-f]{64}$/);
  assert.notEqual(sa, sb, '같은 IP의 다른 세션 = 다른 사용자 키(IP 단독 식별 아님)');
  assert.equal(sa, sa2, '같은 세션 = 같은 사용자 키');
  const ipHash = createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: SKEY }).ipHash(IP);
  assert.ok(![ipHash, IP].includes(sa!) && !sa!.includes(a.session));
  const sid = a.session.split('.')[0]!;
  assert.notEqual(aiScopeFor(SKEY, sid), sid);
  assert.equal(aiScopeFor(SKEY, 'x'), aiScopeFor(SKEY, 'x'));
  assert.notEqual(aiScopeFor(SKEY, 'x'), aiScopeFor(Buffer.alloc(32, 8), 'x'), '키가 다르면 다른 값(키 없이 추측 불가)');
});

test('PD6 세션 재발급 우회 방어(정적 확인): 새 세션은 봇 확인 + IP당 시간 한도 + DB 공용 한도, 전체 일·월 하드 한도는 세션과 무관', () => {
  const route = readFileSync('src/app/api/consult/chat/route.ts', 'utf8');
  assert.match(route, /const newSessionLimiter = createLimiter\(5, 3_600_000\)/, 'IP당 새 세션 1시간 5개');
  assert.match(route, /botCheck: \(token, from\) => verifyTurnstile\(token, from\)/);
  assert.ok(!/budgetScope/.test(route), '라우트는 IP로 사용자 한도 키를 만들지 않는다');
  const h = readFileSync('src/server/consult/chatHandler.ts', 'utf8');
  assert.match(h, /const scope = aiScopeFor\(d\.sessionKey as Buffer, sessionId\);/);
  assert.match(h, /d\.rateLimit\('session'\)/);
  const mig = readFileSync('db/migrations/0028_ai_cost_hardlimit.sql', 'utf8');
  assert.match(mig, /s\.month_all \+ p_cost > c\.monthly_limit_krw or s\.day_all \+ p_cost > c\.daily_limit_krw/, '전체 한도는 사용자 키와 무관하게 먼저 막는다');
});
