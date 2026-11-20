// 상담창 금액 안내 시험 — 가상 정책만 사용
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerQuote, guardAiReply, NO_APPROVED_POLICIES } from '../../src/server/consult/quoteAnswer';
import { NEEDS_REVIEW_GUIDANCE } from '../../src/server/policies';
import type { PolicyRecord, QuoteRequest } from '../../src/server/policies';

const NOW = new Date('2026-11-23T12:00:00+09:00');
const K = <T,>(value: T) => ({ known: true as const, value });
const rec: PolicyRecord = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic',
  productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved',
  confirmedAt: '2026-11-23T09:00:00+09:00', validFrom: '2026-11-23T00:00:00+09:00', validUntil: K('2026-11-24T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' as const }), contractMonths: K(36),
  equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' as const }), installFee: K({ amountKrw: 2222, vat: 'included' as const }),
  bundlePrerequisites: K([] as string[]), regionScope: K('nationwide' as const),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card' as const, payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
};
const req: QuoteRequest = { supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', confirmedBundles: K([] as string[]) };

test('CQ1 기본 공급자(빈 목록)는 항상 담당자 확인 안내, 금액 없음', () => {
  assert.deepEqual(answerQuote(NO_APPROVED_POLICIES, req, NOW), { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
});
test('CQ2 승인 정책이 있으면 견적 문장, 공급자 오류·비배열은 닫힘', () => {
  const a = answerQuote(() => [rec], req, NOW);
  assert.equal(a.kind, 'quote');
  assert.ok(a.text.includes('11,111원') && !a.text.includes('999999'));
  assert.equal(answerQuote(() => { throw new Error('db down'); }, req, NOW).kind, 'needs_review');
  assert.equal(answerQuote((() => 'x') as never, req, NOW).kind, 'needs_review');
  assert.equal(answerQuote(() => [{ ...rec, reviewStatus: 'draft' }], req, NOW).kind, 'needs_review');
});
test('CQ3 AI 문장: 승인 견적의 금액만 허용', () => {
  const approved = answerQuote(() => [rec], req, NOW);
  assert.equal(guardAiReply('월 11,111원이고 설치비는 2,222원입니다.', approved).kind, 'quote');
  assert.equal(guardAiReply('월 11,111원이고 설치비는 2,222원입니다.', approved).text, '월 11,111원이고 설치비는 2,222원입니다.');
});
test('CQ4 AI 문장: 승인 밖 금액·한글 수사 금액·형식 오류는 안내문으로 교체', () => {
  const approved = answerQuote(() => [rec], req, NOW);
  for (const t of ['월 9,900원에 가능합니다', '월 5만원', '3천원 할인', '삼만원 상품권', '이만 원', '사은품 50000', 123, null, 'x'.repeat(2001)]) {
    assert.deepEqual(guardAiReply(t, approved), { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE }, String(t));
  }
});
test('CQ5 승인 견적이 없으면 AI 문장의 어떤 금액도 허용하지 않음, 금액 없는 문장은 통과', () => {
  const none = answerQuote(NO_APPROVED_POLICIES, req, NOW);
  assert.equal(guardAiReply('월 11,111원입니다', none).text, NEEDS_REVIEW_GUIDANCE);
  assert.equal(guardAiReply('담당자가 확인 후 안내드리겠습니다.', none).text, '담당자가 확인 후 안내드리겠습니다.');
});
test('CQ6 라우트는 기본 꺼짐·고정 공급자·공급자 환경값 없이는 열리지 않음', () => {
  const r = readFileSync('src/app/api/consult/quote/route.ts', 'utf8');
  assert.match(r, /CONSULT_QUOTE_ENABLED !== 'true'/);
  assert.match(r, /NO_APPROVED_POLICIES/);
  assert.ok(!/server\/policies/.test(r), '라우트는 정책 모듈을 직접 읽지 않는다');
  assert.ok(!/process\.env\.\w*KEY|fetch\(/.test(r));
});
