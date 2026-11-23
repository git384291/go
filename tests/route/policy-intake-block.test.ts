// PM 11/24 결정: 유효한 게시 정책이 없거나(정책 없음·게시 스위치 OFF) 정책 검증 장애면 접수 차단. A(AI 장애)·B(정책 장애) 안내 분리.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget, mockModel } from '../../src/server/consult/chatModel';
import type { ChatModel } from '../../src/server/consult/chatModel';
import { checkPolicy } from '../../src/server/consult/quoteAnswer';
import { intakePolicyFromEnv, policyKeyFromEnv, policyVerdict } from '../../src/server/leads/policyFault';
import { NEEDS_REVIEW_GUIDANCE } from '../../src/server/policies';
import { AI_UNAVAILABLE_GUIDANCE, POLICY_UNVERIFIED_GUIDANCE } from '../../src/content/consultGuidance';

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
const v2 = { ...rec, version: 'v-fixture-2', monthlyFee: K({ amountKrw: 22222, vat: 'included' }) };
const input = (message = '요금이 얼마예요?') => ({ message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' });
const deps = (provider: () => unknown, model: ChatModel | null = mockModel) => ({ provider, supplierId: 'supplier-a', model, budget: createAiBudget({}) }) as never;
const MONEY = /\d{1,3}(,\d{3})+|\d+\s*원/;
const ENV = { QUOTE_SUPPLIER_ID: 'supplier-a', CONSULT_CHAT_CARRIER: 'carrier-x', CONSULT_CHAT_PRODUCT: 'net500-tv-basic', CONSULT_CHAT_REGION: 'region-1' };
const KEY = policyKeyFromEnv(ENV);
const req = { supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', confirmedBundles: { known: false } } as never;
const boom: ChatModel = { name: 'boom', costPerCallKrw: 0, generate: async () => { throw new Error('upstream 500 sk-secret'); } };

test('PV1 상담 도중 정책 버전 교체: 매 메시지 현재 게시 버전만, 교체 순간(두 버전 공존)은 B 안내·접수 잠금·금액 0', async () => {
  let rows: unknown[] = [rec];
  const d = deps(() => rows);
  const a = await answerChat(d, input(), NOW);
  assert.ok(a.ok && a.text.includes('11,111') && a.next !== 'blocked');
  rows = [rec, v2];
  const b = await answerChat(d, input(), NOW);
  assert.ok(b.ok && b.text === POLICY_UNVERIFIED_GUIDANCE && b.next === 'blocked' && !MONEY.test(b.text));
  assert.equal(await policyVerdict(KEY, rows, NOW), 'POLICY_UNVERIFIED', '같은 순간 접수도 차단');
  rows = [v2];
  const c = await answerChat(d, input(), NOW);
  assert.ok(c.ok && c.text.includes('22,222') && !c.text.includes('11,111') && c.next !== 'blocked');
  assert.equal(await policyVerdict(KEY, rows, NOW), null);
});

test('PV2 [필수1·2] 정책 없음·게시 스위치 OFF(DB 0행) → 접수 거부(POLICY_NOT_PUBLISHED), 상담 안내는 금액 없이 유지하고 접수 잠금', async () => {
  assert.equal(await policyVerdict(KEY, [], NOW), 'POLICY_NOT_PUBLISHED');
  const r = await answerChat(deps(() => []), input(), NOW);
  assert.ok(r.ok && r.next === 'blocked' && r.kind === 'needs_review' && !MONEY.test(r.text) && !('callbackPrompt' in r));
  // OFF 전환과 상담 동시 요청: ON 시점에 읽은 요청은 그때 승인 값만, OFF 뒤 읽은 요청은 금액 0·접수 잠금
  let on = true;
  let release!: () => void;
  const hold = new Promise<void>((res) => { release = res; });
  const p1 = answerChat(deps(async () => { const snap = on ? [rec] : []; await hold; return snap; }), input(), NOW);
  on = false;
  const r2 = await answerChat(deps(() => (on ? [rec] : [])), input(), NOW);
  release();
  const r1 = await p1;
  assert.ok(r2.ok && r2.next === 'blocked' && !MONEY.test(r2.text), 'OFF 뒤: 금액 없음·접수 잠금');
  assert.ok(r1.ok && [...r1.text.matchAll(/\d{1,3}(?:,\d{3})+/g)].every((m) => ['11,111', '2,222', '3,333'].includes(m[0])), 'ON 시점: 승인 값만');
});

test('PV3 [필수5] 만료·철회·미승인·시작 전·형식 오류 정책, 키 미설정, 고객 값 우회 → 접수 차단', async () => {
  const expired = { ...rec, validUntil: K('2026-11-23T11:00:00+09:00') };
  const notApproved = { ...rec, reviewStatus: 'submitted' };
  const future = { ...rec, validFrom: '2026-11-24T00:00:00+09:00', validUntil: K('2026-11-25T00:00:00+09:00') };
  const malformed = { ...rec, monthlyFee: 'cheap' };
  for (const [name, row] of [['expired', expired], ['notApproved', notApproved], ['future', future], ['malformed', malformed]] as const) {
    const r = await answerChat(deps(() => [row]), input(), NOW);
    assert.ok(r.ok && r.text === POLICY_UNVERIFIED_GUIDANCE && r.next === 'blocked' && !MONEY.test(r.text), name);
    assert.equal((await checkPolicy(() => [row], req, NOW)).answer.text, NEEDS_REVIEW_GUIDANCE, `${name}: 견적 문장 없음`);
    assert.equal(await policyVerdict(KEY, [row], NOW), 'POLICY_UNVERIFIED', `${name}: 접수 차단`);
  }
  assert.equal(await policyVerdict(KEY, ['not-an-object'], NOW), 'POLICY_UNVERIFIED');
  // 철회(게시 목록에서 빠짐) 뒤 모델이 옛 금액을 말해도 가드가 막고 접수는 잠김
  const old = await answerChat(deps(() => [], { name: 'old', costPerCallKrw: 0, generate: async () => '월 11,111원에 사은품 3,333원 드려요' }), input(), NOW);
  assert.ok(old.ok && old.source === 'fallback' && !MONEY.test(old.text) && old.next === 'blocked');
  // 키는 서버 설정만: 미설정·형식 오류면 차단(고객이 보낸 상품 키·이전 상담 결과를 받는 입력 자체가 없다)
  assert.equal(policyKeyFromEnv({}), null);
  assert.equal(await policyVerdict(null, [rec], NOW), 'POLICY_NOT_PUBLISHED');
  assert.equal(intakePolicyFromEnv({ ...ENV, CONSULT_CHAT_PRODUCT: 'Bad Key' }).key, null);
  assert.equal(await intakePolicyFromEnv({ ...ENV, CONSULT_CHAT_PRODUCT: 'other-product' }).verdict([rec], NOW), 'POLICY_NOT_PUBLISHED', '다른 상품 정책으로는 통과 못 함');
});

test('PV4 [필수3] AI 장애 + 정상 게시 정책 → A 안내·승인 견적 문장·접수 허용 가능(signup), AI 장애 + 정책 없음/장애 → 차단', async () => {
  for (const model of [null, boom]) {
    const ok = await answerChat(deps(() => [rec], model), input(), NOW);
    assert.ok(ok.ok && ok.text.startsWith(AI_UNAVAILABLE_GUIDANCE) && ok.text.includes('11,111') && ok.next === 'signup' && !JSON.stringify(ok).includes('sk-secret'));
    assert.equal(await policyVerdict(KEY, [rec], NOW), null, '정책 조건 통과(고지 등은 접수 API가 따로 검사)');
    const none = await answerChat(deps(() => [], model), input(), NOW);
    assert.ok(none.ok && none.text === AI_UNAVAILABLE_GUIDANCE && none.next === 'blocked');
  }
  let called = 0;
  const spy: ChatModel = { name: 'spy', costPerCallKrw: 0, generate: async () => { called++; return 'x'; } };
  const b = await answerChat(deps(() => { throw new Error('db down'); }, spy), input(), NOW);
  assert.ok(b.ok && b.next === 'blocked' && b.text === POLICY_UNVERIFIED_GUIDANCE && called === 0, 'B가 A보다 우선, 모델 미호출');
});

test('PV5 배선: 접수 API·상태 API·화면·DB 게이트가 같은 판정(서버 설정 키·현재 게시 정책)을 쓴다', () => {
  assert.match(readFileSync('src/app/api/leads/route.ts', 'utf8'), /policy: intakePolicyFromEnv\(process\.env\)/);
  const st = readFileSync('src/app/api/leads/status/route.ts', 'utf8');
  assert.ok(st.includes('intakePolicyFromEnv(process.env)') && st.includes('api.policy_published()') && /open: false[^\n]*fail-closed/.test(st));
  const s = readFileSync('src/server/leads/submitLead.ts', 'utf8');
  const gate = s.indexOf('api.policy_intake_gate(${k.supplierId}, ${k.carrier}, ${k.productId})');
  assert.ok(gate > 0 && gate < s.indexOf('api.create_lead(') && s.indexOf('api.notice_intake_gate(') < gate);
  const form = readFileSync('src/components/ConsultForm.tsx', 'utf8');
  assert.match(form, /disabled=\{!hasOption \|\| isBlocked\}/);
  assert.match(form, /if \(!FORM_ENABLED \|\| !hasOption \|\| isBlocked\) return;/);
  assert.match(form, /fetch\('\/api\/leads\/status'/);
  assert.match(readFileSync('src/components/ConsultAiChat.tsx', 'utf8'), /j\.next === 'blocked'/);
  const safe = /export const SAFE = '([^']+)';/.exec(readFileSync('src/components/ConsultAiChat.tsx', 'utf8'))?.[1] ?? '';
  assert.ok(safe.startsWith(AI_UNAVAILABLE_GUIDANCE));
  const mig = readFileSync('db/migrations/0026_policy_intake_rule.sql', 'utf8');
  assert.ok(/POLICY_PUBLISH_OFF/.test(mig) && /POLICY_NOT_PUBLISHED/.test(mig) && /pg_advisory_xact_lock_shared/.test(mig));
  assert.ok(!/set enabled\s*=\s*true/i.test(mig), '마이그레이션은 게시 스위치를 켜지 않는다');
});
