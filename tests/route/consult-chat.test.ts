// AI 상담 답변 시험 — 무료 모의 모델·가상 정책만 사용. 실제 API 호출 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget, createDbAiBudget, createModel, mockModel } from '../../src/server/consult/chatModel';
import type { ChatModel, ModelInput } from '../../src/server/consult/chatModel';
import { maskPii } from '../../src/server/consult/piiMask';
import { createLimiter, handleChat } from '../../src/server/consult/chatHandler';
import { NEEDS_REVIEW_GUIDANCE } from '../../src/server/policies';

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
const deps = (over: Record<string, unknown> = {}) => ({ provider: () => [rec], supplierId: 'supplier-a', model: mockModel, budget: createAiBudget({}), ...over }) as never;
const fake = (fn: (i: ModelInput, s: AbortSignal) => Promise<string>, cost = 0): ChatModel => ({ name: 'fake', costPerCallKrw: cost, generate: fn });

test('CH1 승인 정책이면 모의 모델이 승인 금액만 안내하고 가입 신청으로 이어진다', async () => {
  const r = await answerChat(deps(), input(), NOW);
  assert.ok(r.ok && r.kind === 'quote' && r.source === 'model' && r.next === 'signup');
  assert.ok(r.ok && r.text.includes('11,111') && r.text.includes('3,333'));
  assert.ok(r.ok && !r.text.includes('999') && !r.text.includes('internal'));
});
test('CH2 정책 없음·공급자 오류는 담당자 확인 안내(금액·혜택 없음)', async () => {
  for (const provider of [() => [], () => { throw new Error('boom'); }]) {
    const r = await answerChat(deps({ provider }), input(), NOW);
    assert.ok(r.ok && r.kind === 'needs_review');
    assert.ok(r.ok && !/\d{3,}/.test(r.text));
  }
});
test('CH3 모델이 승인 밖 금액·혜택을 지어내면 승인 안내문으로 대체', async () => {
  for (const evil of ['월 9,900원에 해 드려요', '사은품 5만원 추가 드려요', '월 삼만원입니다', '월 11,111원이고 사은품 30만원']) {
    const r = await answerChat(deps({ model: fake(async () => evil) }), input(), NOW);
    assert.ok(r.ok && r.source === 'fallback' && !r.text.includes(evil.slice(0, 6)), evil);
  }
  // 승인 정책이 없는데 혜택을 말하면 막힘
  const r = await answerChat(deps({ provider: () => [], model: fake(async () => '상품권을 드립니다') }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback' && r.text === NEEDS_REVIEW_GUIDANCE);
});
test('CH4 모델 장애·시간 초과는 안전 안내문, 오류 문구는 고객에게 안 감', async () => {
  const boom = await answerChat(deps({ model: fake(async () => { throw new Error('SECRET api key sk-123'); }) }), input(), NOW);
  assert.ok(boom.ok && boom.source === 'fallback' && !JSON.stringify(boom).includes('sk-123'));
  const slow = await answerChat(deps({ timeoutMs: 20, model: fake((_i, s) => new Promise((res) => { s.addEventListener('abort', () => res('late')); })) }), input(), NOW);
  assert.ok(slow.ok && slow.source === 'fallback');
});
test('CH5 사용료 예약: 기본 0원이면 유료 모델은 호출 0회, 한도 초과 뒤에도 호출 안 함(모의는 0원이라 통과), 집계 오류는 호출 금지', async () => {
  let calls = 0;
  const paid = fake(async () => { calls++; return '안내'; }, 5);
  const r0 = await answerChat(deps({ model: paid, budget: createAiBudget({}) }), input(), NOW);
  assert.ok(r0.ok && r0.source === 'fallback' && calls === 0);
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '10' });
  for (let i = 0; i < 4; i++) await answerChat(deps({ model: paid, budget: b }), input(), NOW);
  assert.equal(calls, 2);
  assert.equal(await createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '-5' }).reserve(1), false);
  assert.equal(await createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: 'abc' }).reserve(1), false);
  assert.equal(await createAiBudget({}).reserve(0), true);
  // DB 집계: true만 통과, false·형식 밖·예외는 모두 호출 금지, 비용 0은 DB를 부르지 않음
  const mk = (rows: unknown, boom = false) => { let n = 0; return { n: () => n, b: createDbAiBudget(async (fn) => { n++; if (boom) throw new Error('db down'); return fn((() => Promise.resolve(rows)) as never); }) }; };
  assert.equal(await mk([{ ok: true }]).b.reserve(5), true);
  for (const bad of [[{ ok: false }], [], [{ ok: 'true' }], null]) assert.equal(await mk(bad).b.reserve(5), false);
  assert.equal(await mk([], true).b.reserve(5), false);
  const free = mk([{ ok: true }]);
  assert.equal(await free.b.reserve(0), true);
  assert.equal(free.n(), 0);
  assert.equal(await mk([{ ok: true }]).b.reserve(-1), false);
});
test('CH6 개인정보는 모델에 가려서만 전달된다', async () => {
  let seen = '';
  const spy = fake(async (i) => { seen = JSON.stringify(i); return '확인했습니다'; });
  const msg = '이름은 김철수 전화 010-1234-5678 메일 a.b@c.com 주민 900101-1234567 서울시 강남구 테헤란로 123 101호 요금?';
  await answerChat(deps({ model: spy }), input(msg), NOW);
  for (const raw of ['김철수', '1234-5678', '010-1234', 'a.b@c.com', '900101', '1234567', '테헤란로']) assert.ok(!seen.includes(raw), raw);
  assert.ok(seen.includes('[전화]') && seen.includes('[이메일]'));
  assert.equal(maskPii('요금 문의'), '요금 문의');
});
test('CH7 모델 이름 설정: mock만 모델이 있고 나머지(실제 API 이름 포함)는 모델 없음 → 안전 안내', async () => {
  assert.equal(createModel({ CONSULT_AI_MODEL: 'mock' }), mockModel);
  for (const v of [undefined, '', 'openai', 'gpt-x', 'MOCK']) assert.equal(createModel({ CONSULT_AI_MODEL: v }), null);
  const r = await answerChat(deps({ model: null }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback' && r.kind === 'quote');
});
test('CH8 입력 검사: 빈 글·301자·문자열 아님', async () => {
  for (const m of ['', '   ', 'a'.repeat(301), 5, null, { a: 1 }]) assert.deepEqual(await answerChat(deps(), input(m), NOW), { ok: false, code: 'INVALID_INPUT' });
});
const HD = (over: Record<string, unknown> = {}) => ({ enabled: true, chat: deps(), limiter: createLimiter(2, 60_000), ip: '203.0.113.9', now: () => NOW, ...over }) as never;
const post = (b: unknown, raw?: string) => new Request('http://x/api/consult/chat', { method: 'POST', body: raw ?? JSON.stringify(b) });
const good = { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?' };
test('CH9 핸들러: 꺼짐 503·크기 413·형식 400·여분 키 400·횟수 제한 429·no-store', async () => {
  assert.equal((await handleChat(post(good), HD({ enabled: false }))).status, 503);
  assert.equal((await handleChat(post(good), HD({ chat: null }))).status, 503);
  assert.equal((await handleChat(post(null, 'x'.repeat(3000)), HD())).status, 413);
  assert.equal((await handleChat(post(null, '{bad'), HD())).status, 400);
  assert.equal((await handleChat(post({ ...good, extra: 1 }), HD())).status, 400);
  assert.equal((await handleChat(post({ ...good, carrier: 'Bad Key!' }), HD())).status, 400);
  assert.equal((await handleChat(post({ ...good, message: '' }), HD())).status, 400);
  const d = HD();
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await handleChat(post(good), d)).status);
  assert.deepEqual(codes, [200, 200, 429]);
  const ok = await handleChat(post(good), HD());
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const j = await ok.json();
  assert.ok(j.ok && j.kind === 'quote' && !JSON.stringify(j).includes('CONSULT_AI'));
});
test('CH10 정적: 키 환경변수는 서버 모듈에서만, 클라이언트 파일은 상담 서버 모듈·키를 import하지 않음, 실제 AI 주소·SDK 없음', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk('src').filter((p) => /\.(ts|tsx)$/.test(p))) {
    const s = readFileSync(f, 'utf8');
    if (/^['"]use client['"]/.test(s.trimStart())) assert.ok(!/server\/consult|CONSULT_AI|API_KEY/.test(s), `${f}: 클라이언트 파일`);
    if (f.startsWith(path.join('src', 'server', 'consult'))) assert.ok(!/api\.openai\.com|api\.anthropic\.com|from ['"]openai['"]|fetch\(/.test(s), `${f}: 실제 API 호출 없음`);
    if (/CONSULT_AI_API_KEY/.test(s)) assert.ok(f.startsWith(path.join('src', 'server')), `${f}: 키는 서버 코드에서만`);
  }
});
