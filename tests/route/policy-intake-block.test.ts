// PM 11/24 추가 지시: A(AI 상담 장애)·B(정책 검증 장애) 분리, 정책 변경 순간(버전 교체·게시 스위치 OFF·만료/철회 우회) 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget, mockModel } from '../../src/server/consult/chatModel';
import type { ChatModel } from '../../src/server/consult/chatModel';
import { checkPolicy } from '../../src/server/consult/quoteAnswer';
import { policyFaultFromEnv } from '../../src/server/leads/policyFault';
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
const req = { supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', confirmedBundles: { known: false } } as never;

test('PV1 상담 도중 정책 버전 교체: 매 메시지 현재 게시 버전만, 교체 순간(두 버전 공존)은 B 안내·접수 잠금·금액 0', async () => {
  let rows: unknown[] = [rec];
  const d = deps(() => rows);
  const a = await answerChat(d, input(), NOW);
  assert.ok(a.ok && a.text.includes('11,111') && a.next !== 'blocked');
  rows = [rec, v2]; // 교체 중: 승인 유효 버전 두 개
  const b = await answerChat(d, input(), NOW);
  assert.ok(b.ok && b.text === POLICY_UNVERIFIED_GUIDANCE && b.next === 'blocked' && b.source === 'fallback' && !MONEY.test(b.text));
  rows = [v2]; // 교체 완료
  const c = await answerChat(d, input(), NOW);
  assert.ok(c.ok && c.text.includes('22,222') && !c.text.includes('11,111') && c.next !== 'blocked');
});

test('PV2 게시 스위치 OFF 전환과 상담 동시 요청: OFF 뒤 읽은 요청은 금액 0·정상 담당자 확인(장애 아님), 이전 요청은 그때 승인 값만', async () => {
  let on = true;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // 첫 요청은 스위치 ON 상태를 읽은 직후 멈추고, 그사이 OFF로 바뀐 뒤 두 번째 요청이 들어온다
  const slow = deps(async () => { const snap = on ? [rec] : []; await gate; return snap; });
  const p1 = answerChat(slow, input(), NOW);
  on = false;
  const p2 = answerChat(deps(() => (on ? [rec] : [])), input(), NOW);
  const r2 = await p2;
  release();
  const r1 = await p1;
  assert.ok(r2.ok && r2.kind === 'needs_review' && r2.next !== 'blocked' && !MONEY.test(r2.text), 'OFF 뒤: 금액 없음');
  assert.ok(r1.ok && (!MONEY.test(r1.text) || [...r1.text.matchAll(/\d{1,3}(?:,\d{3})+/g)].every((m) => ['11,111', '2,222', '3,333'].includes(m[0]))), 'ON 시점: 승인 값만');
});

test('PV3 만료·철회·미승인·시작 전 정책으로 우회 시도: 상담은 B 안내·금액 0, 접수 판정기도 장애(true)', async () => {
  const expired = { ...rec, validUntil: K('2026-11-23T11:00:00+09:00') };
  const notApproved = { ...rec, reviewStatus: 'submitted' };
  const future = { ...rec, validFrom: '2026-11-24T00:00:00+09:00', validUntil: K('2026-11-25T00:00:00+09:00') };
  const malformed = { ...rec, monthlyFee: 'cheap' };
  const fault = policyFaultFromEnv(ENV);
  for (const [name, row] of [['expired', expired], ['notApproved', notApproved], ['future', future], ['malformed', malformed]] as const) {
    const r = await answerChat(deps(() => [row]), input(), NOW);
    assert.ok(r.ok && r.text === POLICY_UNVERIFIED_GUIDANCE && r.next === 'blocked' && !MONEY.test(r.text), name);
    assert.equal((await checkPolicy(() => [row], req, NOW)).answer.text, NEEDS_REVIEW_GUIDANCE, `${name}: 견적 문장 없음`);
    assert.equal(await fault([row], NOW), true, `${name}: 접수 차단`);
  }
  // 철회(게시 목록에서 빠짐)된 뒤 모델이 옛 금액을 말해도 가드가 막는다
  const old = await answerChat(deps(() => [], { name: 'old', costPerCallKrw: 0, generate: async () => '월 11,111원에 사은품 3,333원 드려요' }), input(), NOW);
  assert.ok(old.ok && old.source === 'fallback' && !MONEY.test(old.text));
  // 정상 상태(정책 없음·정상 승인)는 접수 판정 장애 아님, 키 미설정이면 행 형식만 본다
  assert.equal(await fault([], NOW), false);
  assert.equal(await fault([rec], NOW), false);
  assert.equal(await policyFaultFromEnv({})([], NOW), false);
  assert.equal(await policyFaultFromEnv({})(['not-an-object'], NOW), true);
  // 고객이 다른 키를 보내 우회할 수 없다: 판정 키는 서버 설정만 쓴다(행이 같으면 결과도 같다)
  assert.equal(await policyFaultFromEnv({ ...ENV, CONSULT_CHAT_PRODUCT: 'Bad Key' })([expired], NOW), false, '키 형식 오류면 키 판정 없이 형식만(행은 객체라 통과)');
});

test('PV4 A 상태(AI 장애): 모델 없음·오류·시간 초과는 A 안내, 승인 견적이 있으면 그 문장만 덧붙이고 접수는 잠그지 않는다', async () => {
  const boom: ChatModel = { name: 'boom', costPerCallKrw: 0, generate: async () => { throw new Error('upstream 500 sk-secret'); } };
  for (const model of [null, boom]) {
    const none = await answerChat(deps(() => [], model), input(), NOW);
    assert.ok(none.ok && none.text === AI_UNAVAILABLE_GUIDANCE && none.next !== 'blocked' && !JSON.stringify(none).includes('sk-secret'));
    const q = await answerChat(deps(() => [rec], model), input(), NOW);
    assert.ok(q.ok && q.text.startsWith(AI_UNAVAILABLE_GUIDANCE) && q.text.includes('11,111') && q.next === 'signup');
  }
  // B가 A보다 우선: 정책 장애면 모델을 부르지 않는다
  let called = 0;
  const spy: ChatModel = { name: 'spy', costPerCallKrw: 0, generate: async () => { called++; return 'x'; } };
  const b = await answerChat(deps(() => { throw new Error('db down'); }, spy), input(), NOW);
  assert.ok(b.ok && b.next === 'blocked' && called === 0);
});

test('PV5 배선: 접수 경로는 판정기를 넣고, 정책 게이트가 저장보다 먼저, 화면은 blocked면 접수 버튼 잠금', () => {
  assert.match(readFileSync('src/app/api/leads/route.ts', 'utf8'), /policyFault: policyFaultFromEnv\(process\.env\)/);
  const s = readFileSync('src/server/leads/submitLead.ts', 'utf8');
  assert.ok(s.indexOf('api.policy_intake_gate()') > 0 && s.indexOf('api.policy_intake_gate()') < s.indexOf('api.create_lead('));
  assert.ok(s.indexOf('api.notice_intake_gate(') < s.indexOf('api.policy_intake_gate()'));
  const form = readFileSync('src/components/ConsultForm.tsx', 'utf8');
  assert.match(form, /disabled=\{!hasOption \|\| blocked\}/);
  assert.match(form, /if \(!FORM_ENABLED \|\| !hasOption \|\| blocked\) return;/);
  assert.match(readFileSync('src/components/ConsultAiChat.tsx', 'utf8'), /j\.next === 'blocked'/);
  const safe = /export const SAFE = '([^']+)';/.exec(readFileSync('src/components/ConsultAiChat.tsx', 'utf8'))?.[1] ?? '';
  assert.ok(safe.startsWith(AI_UNAVAILABLE_GUIDANCE), '화면 실패 안내는 A 문구로 시작');
  assert.match(readFileSync('src/components/ConsultAiFlow.tsx', 'utf8'), /blocked=\{policyBlocked\}/);
  const mig = readFileSync('db/migrations/0025_policy_intake_gate.sql', 'utf8');
  assert.match(mig, /pg_advisory_xact_lock_shared/);
  assert.ok(!/policy_publish'?\s*,\s*true|enabled\s*=\s*true/.test(mig), '마이그레이션은 게시 스위치를 켜지 않는다');
});
