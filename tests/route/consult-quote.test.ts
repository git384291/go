// 상담창 금액 안내 시험 — 가상 정책만 사용
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerQuote, guardAiReply, NO_APPROVED_POLICIES } from '../../src/server/consult/quoteAnswer';
import { dbPolicyProvider } from '../../src/server/consult/publishedPolicies';
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

test('CQ1 기본 공급자(빈 목록)는 항상 담당자 확인 안내, 금액 없음', async () => {
  assert.deepEqual(await answerQuote(NO_APPROVED_POLICIES, req, NOW), { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
});
test('CQ2 승인 정책이 있으면 견적 문장, 공급자 오류·비배열은 닫힘', async () => {
  const a = await answerQuote(() => [rec], req, NOW);
  assert.equal(a.kind, 'quote');
  assert.ok(a.text.includes('11,111원') && !a.text.includes('999999'));
  assert.equal((await answerQuote(() => { throw new Error('db down'); }, req, NOW)).kind, 'needs_review');
  assert.equal((await answerQuote((() => 'x') as never, req, NOW)).kind, 'needs_review');
  assert.equal((await answerQuote(() => [{ ...rec, reviewStatus: 'draft' }], req, NOW)).kind, 'needs_review');
});
test('CQ3 AI 문장: 승인 견적의 금액만 허용', async () => {
  const approved = await answerQuote(() => [rec], req, NOW);
  assert.equal(guardAiReply('월 11,111원이고 설치비는 2,222원입니다.', approved).kind, 'quote');
  assert.equal(guardAiReply('월 11,111원이고 설치비는 2,222원입니다.', approved).text, '월 11,111원이고 설치비는 2,222원입니다.');
});
test('CQ4 AI 문장: 승인 밖 금액·한글 수사 금액·형식 오류는 안내문으로 교체', async () => {
  const approved = await answerQuote(() => [rec], req, NOW);
  for (const t of ['월 9,900원에 가능합니다', '월 5만원', '3천원 할인', '삼만원 상품권', '이만 원', '사은품 50000', 123, null, 'x'.repeat(2001)]) {
    assert.deepEqual(guardAiReply(t, approved), { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE }, String(t));
  }
});
test('CQ5 승인 견적이 없으면 AI 문장의 어떤 금액도 허용하지 않음, 금액 없는 문장은 통과', async () => {
  const none = await answerQuote(NO_APPROVED_POLICIES, req, NOW);
  assert.equal(guardAiReply('월 11,111원입니다', none).text, NEEDS_REVIEW_GUIDANCE);
  assert.equal(guardAiReply('담당자가 확인 후 안내드리겠습니다.', none).text, '담당자가 확인 후 안내드리겠습니다.');
});
test('CQ6 라우트는 기본 꺼짐·고정 공급자·공급자 환경값 없이는 열리지 않음', () => {
  const r = readFileSync('src/app/api/consult/quote/route.ts', 'utf8');
  assert.match(r, /CONSULT_QUOTE_ENABLED !== 'true'/);
  assert.match(r, /dbPolicyProvider/);
  assert.match(r, /api\.policy_published\(\)/);
  assert.ok(!/server\/policies/.test(r), '라우트는 정책 모듈을 직접 읽지 않는다');
  assert.ok(!/process\.env\.\w*KEY|fetch\(/.test(r));
});

// ---- 게시 정책 연결(PM 11/21 1~3항): DB 행은 jsonb로 오고, 서버가 견적 판정에서 다시 검사한다
const dbRow = (patch: Record<string, unknown> = {}) => {
  const { internal: _i, ...rest } = rec;
  void _i;
  return { ...rest, version: 'r1', ...patch };
};
const fixedFetch = (rows: unknown) => dbPolicyProvider(async () => rows as never);

test('CQ7 게시 행 → 견적 문장, 내부 필드는 항상 null', async () => {
  const a = await answerQuote(fixedFetch([dbRow({ internal: { commissionKrw: 999999, sourceRef: 'internal://x' } })]), req, NOW);
  assert.equal(a.kind, 'quote');
  assert.ok(a.text.includes('11,111원') && !a.text.includes('999999') && !a.text.includes('internal://'));
});
test('CQ8 DB 조회 실패·비배열·잘못된 행은 담당자 확인 안내(금액 없음)', async () => {
  const bad: ((n: Date) => unknown)[] = [() => { throw new Error('db down'); }, () => 'x', () => [null], () => [[1]], () => ['x']];
  for (const f of bad) {
    const a = await answerQuote(dbPolicyProvider(async () => f(NOW) as never), req, NOW);
    assert.deepEqual(a, { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
  }
});
test('CQ9 서버 재검증: 만료·미승인·시작 전 행이 섞여 와도 금액이 나가지 않음', async () => {
  const cases = [
    dbRow({ reviewStatus: 'draft' }),
    dbRow({ validUntil: K('2026-11-23T10:00:00+09:00') }),               // 이미 만료
    dbRow({ validFrom: '2026-11-24T00:00:00+09:00', validUntil: K('2026-11-25T00:00:00+09:00') }), // 아직 시작 전
    dbRow({ confirmedAt: '2026-11-24T09:00:00+09:00' }),                   // 확인 시각이 미래
    dbRow({ sourceKind: 'past_promotion' }),
  ];
  for (const c of cases) assert.equal((await answerQuote(fixedFetch([c]), req, NOW)).kind, 'needs_review');
});
test('CQ10 정책 교체 중 두 버전이 함께 와도 금액을 내지 않음(충돌은 닫힘), 한 버전만 오면 그 금액만', async () => {
  const r1 = dbRow({ version: 'r1' });
  const r2 = dbRow({ version: 'r2', monthlyFee: K({ amountKrw: 9999, vat: 'included' }) });
  const both = await answerQuote(fixedFetch([r1, r2]), req, NOW);
  assert.deepEqual(both, { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
  const only2 = await answerQuote(fixedFetch([r2]), req, NOW);
  assert.ok(only2.kind === 'quote' && only2.text.includes('9,999원') && !only2.text.includes('11,111원'));
  const only1 = await answerQuote(fixedFetch([r1]), req, NOW);
  assert.ok(only1.kind === 'quote' && only1.text.includes('11,111원') && !only1.text.includes('9,999원'));
});
test('CQ11 정책 없음(게시 스위치 꺼짐 등으로 DB가 0행)은 담당자 확인 안내', async () => {
  assert.deepEqual(await answerQuote(fixedFetch([]), req, NOW), { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
});
