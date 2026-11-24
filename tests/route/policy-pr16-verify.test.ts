// PR #16 추가 검증(PM 11/25): 비활성 상품 노출 차단·요금/사은품/설치비/고지 정확성·캐시 갱신. 가상 정책만 사용한다.
// 기존 Q1~Q22·CQ·PS1~PS17과 겹치지 않게 '전체 문장 정확 일치'·'상품 전수'·'매 호출 재조회'만 다룬다.
// react-server 조건(test:route)에서 실행: 모듈은 server-only 경계.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { answerQuote, checkPolicy, guardAiReply } from '../../src/server/consult/quoteAnswer';
import { dbPolicyProvider } from '../../src/server/consult/publishedPolicies';
import { CATALOG, ACTIVE_INTERESTS } from '../../src/content/catalog';
import { NEEDS_REVIEW_GUIDANCE, QUOTE_NOTICES, quotePolicy, renderQuoteMessage } from '../../src/server/policies';
import type { PolicyRecord, QuoteRequest } from '../../src/server/policies';

const NOW = new Date('2026-11-25T12:00:00+09:00');
const K = <T,>(value: T) => ({ known: true as const, value });
const base: PolicyRecord = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic',
  productLabel: '인터넷 + TV 검증용(가상)', category: 'internet_tv', version: 'r1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved',
  confirmedAt: '2026-11-25T09:00:00+09:00', validFrom: '2026-11-25T00:00:00+09:00', validUntil: K('2026-11-26T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 27700, vat: 'included' as const }), contractMonths: K(36),
  equipmentMonthlyFee: K({ amountKrw: 2200, vat: 'excluded' as const }), installFee: K({ amountKrw: 33000, vat: 'included' as const }),
  bundlePrerequisites: K(['mobile-bundle-a']), regionScope: K('nationwide' as const),
  customerBenefit: K({ amountKrw: 5500, form: 'gift_card' as const, payoutCondition: K('개통 완료 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 888888, sourceRef: 'internal://pr16' },
};
const req: QuoteRequest = { supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', confirmedBundles: K(['mobile-bundle-a']) };
const rec = (patch: Partial<PolicyRecord>): PolicyRecord => ({ ...base, ...patch });
const MONEY = /\d[\d,]*\s*원|[0-9]{4,}/;

// ---- A. 비활성 상품 노출 차단 -----------------------------------------------------------------------------------------

test('V1 활성 상품은 인터넷+TV(internet_tv) 하나뿐, 나머지 5개는 모두 예약(비노출)', () => {
  assert.deepEqual([...ACTIVE_INTERESTS], ['internet_tv']);
  const reserved = Object.keys(CATALOG).filter((k) => CATALOG[k as keyof typeof CATALOG].status === 'reserved').sort();
  assert.deepEqual(reserved, ['cctv_security', 'internet_only', 'internet_phone', 'mobile', 'other']);
});

test('V2 비활성 상품 정책은 승인·유효여도 견적·금액이 나가지 않고(5개 전수 + 모르는 값), 정책 없음으로 닫힘', async () => {
  for (const category of ['internet_phone', 'internet_only', 'cctv_security', 'other', 'mobile', 'tv_only', 'INTERNET_TV', '']) {
    const r = quotePolicy([rec({ category })], req, NOW);
    assert.equal(r.status, 'needs_review', category);
    assert.ok(r.status === 'needs_review' && (r.reasons.includes('PRODUCT_NOT_ACTIVE') || r.reasons.includes('INPUT_INVALID')), category);
    const text = renderQuoteMessage(r).text;
    assert.equal(text, NEEDS_REVIEW_GUIDANCE, category);
    assert.ok(!MONEY.test(text), `${category}: 금액 문자열 없음`);
    const a = await answerQuote(() => [rec({ category })], req, NOW);
    assert.deepEqual({ kind: a.kind, text: a.text }, { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE }, category);
    assert.equal(a.allow, undefined, `${category}: 혜택 허용 정보도 없음`);
  }
});

test('V3 비활성 상품 정책 1건 + 활성 상품 정책 1건이 같이 와도 활성 상품 값만 안내(섞이지 않음)', async () => {
  const inactive = rec({ category: 'mobile', productLabel: '휴대폰 가상', monthlyFee: K({ amountKrw: 99999, vat: 'included' as const }), version: 'r9' });
  const a = await answerQuote(() => [inactive, base], req, NOW);
  // 같은 키(공급처·고객군·통신사·상품)가 둘이면 충돌 → 어느 쪽도 고르지 않는다(fail-closed)
  assert.equal(a.kind, 'needs_review');
  assert.ok(!a.text.includes('99,999'));
  assert.ok(!a.text.includes('27,700'));
  const other = rec({ category: 'mobile', productId: 'mobile-plan-x', monthlyFee: K({ amountKrw: 99999, vat: 'included' as const }) });
  const b = await answerQuote(() => [other, base], req, NOW);
  assert.equal(b.kind, 'quote');
  assert.ok(b.text.includes('27,700원') && !b.text.includes('99,999'));
});

test('V4 비활성 상품 정책은 checkPolicy에서 장애가 아닌 "정책 없음"(present=false)으로 판정', async () => {
  const c = await checkPolicy(() => [rec({ category: 'cctv_security' })], req, NOW);
  assert.equal(c.fault, false);
  assert.equal(c.present, false);
  assert.equal(c.answer.text, NEEDS_REVIEW_GUIDANCE);
});

// ---- B. 요금·사은품·설치비·필수 고지 정확성 -----------------------------------------------------------------------------

test('V5 안내문 전체가 승인 값과 한 글자도 다르지 않음(요금·장비·설치비·결합·사은품 조건·고지 2건)', () => {
  const r = quotePolicy([base], req, NOW);
  assert.equal(r.status, 'quote');
  const expected = [
    '인터넷 + TV 검증용(가상) 안내 (정책 기준 2026-11-25 09:00, 2026-11-26 00:00까지)',
    '- 월 요금: 27,700원(부가세 포함)',
    '- 약정: 36개월',
    '- 장비 월 임대료: 2,200원(부가세 별도)',
    '- 설치비: 33,000원(부가세 포함)',
    '- 결합 전제: mobile-bundle-a',
    '- 사은품: 5,500원 상품권 / 지급 조건: 개통 완료 후 지급(가상) / 해지·환수: 약정 내 해지 시 환수(가상)',
    '※ 설치 가능 여부와 장비 재고는 주소 확인 후 통신사가 최종 확정합니다.',
    '※ 요금·혜택은 표시된 정책 기준 시각의 조건이며, 신청 시점에 다시 확인합니다.',
  ].join('\n');
  const m = renderQuoteMessage(r);
  assert.equal(m.kind, 'quote');
  assert.equal(m.text, expected);
  // 내부 수수료·원문 위치는 안내문 어디에도 없다
  for (const hidden of ['888888', '888,888', 'internal://', 'supplier-a', 'commission']) assert.ok(!m.text.includes(hidden), hidden);
});

test('V6 필수 고지 문구는 정확히 2건이고 안내문마다 빠짐없이 한 번씩, 순서대로 붙음(문구가 바뀌면 이 시험이 실패해 검수 대상이 됨)', () => {
  assert.deepEqual([...QUOTE_NOTICES], [
    '설치 가능 여부와 장비 재고는 주소 확인 후 통신사가 최종 확정합니다.',
    '요금·혜택은 표시된 정책 기준 시각의 조건이며, 신청 시점에 다시 확인합니다.',
  ]);
  const r = quotePolicy([base], req, NOW);
  assert.ok(r.status === 'quote');
  if (r.status !== 'quote') return;
  assert.deepEqual([...r.quote.notices], [...QUOTE_NOTICES]);
  const text = renderQuoteMessage(r).text;
  for (const n of QUOTE_NOTICES) assert.equal(text.split(`※ ${n}`).length - 1, 1, n);
  assert.throws(() => { (QUOTE_NOTICES as string[]).push('x'); }, TypeError); // 동결: 런타임에 고지를 바꿀 수 없다
});

test('V7 경계 금액: 큰 금액은 천 단위 쉼표, 0원은 "0원"(모름과 구분), 사은품 0원·형태 none은 "없음"', () => {
  const big = rec({ monthlyFee: K({ amountKrw: 1234567, vat: 'included' as const }), installFee: K({ amountKrw: 0, vat: 'included' as const }),
    customerBenefit: K({ amountKrw: 0, form: 'none' as const, payoutCondition: K('해당 없음'), cancellationCondition: K('해당 없음') }) });
  const m = renderQuoteMessage(quotePolicy([big], req, NOW));
  assert.equal(m.kind, 'quote');
  assert.ok(m.text.includes('- 월 요금: 1,234,567원(부가세 포함)'));
  assert.ok(m.text.includes('- 설치비: 0원(부가세 포함)'));
  assert.ok(m.text.includes('- 사은품: 없음'));
  assert.ok(!m.text.includes('지급 조건'));
});

test('V8 AI 답변의 금액이 승인 값과 다르면 막고(요금·설치비·사은품 각각), 승인 값 그대로면 통과', async () => {
  const approved = await answerQuote(() => [base], req, NOW);
  assert.equal(approved.kind, 'quote');
  const okText = '월 요금은 27,700원이고 설치비는 33,000원, 사은품은 5,500원 상품권입니다. 약정은 36개월이에요.';
  assert.deepEqual({ ...guardAiReply(okText, approved) }, { kind: 'quote', text: okText });
  for (const wrong of ['월 요금은 28,700원입니다.', '설치비는 30,000원입니다.', '사은품은 6,500원 상품권입니다.', '월 요금은 이만칠천칠백원입니다.']) {
    const g = guardAiReply(wrong, approved);
    assert.deepEqual({ kind: g.kind, text: g.text }, { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE }, wrong);
  }
});

// ---- C. 캐시 갱신 -----------------------------------------------------------------------------------------------------

test('V9 매 호출 재조회: 새 버전 게시→새 금액, 게시 OFF→금액 없음, 조회 장애→이전 금액을 재사용하지 않고 닫힘', async () => {
  let calls = 0;
  let rows: unknown[] = [base];
  let fail = false;
  const provider = dbPolicyProvider(async () => { calls += 1; if (fail) throw new Error('DB_DOWN'); return rows; });
  const a1 = await answerQuote(provider, req, NOW);
  assert.ok(a1.text.includes('27,700원') && calls === 1);

  rows = [rec({ version: 'r2', monthlyFee: K({ amountKrw: 29900, vat: 'included' as const }) })]; // 새 버전 승인·게시
  const a2 = await answerQuote(provider, req, NOW);
  assert.ok(a2.text.includes('29,900원') && !a2.text.includes('27,700') && calls === 2);

  rows = []; // 게시 스위치 OFF 또는 만료 → DB가 0건
  const a3 = await answerQuote(provider, req, NOW);
  assert.deepEqual({ kind: a3.kind, text: a3.text }, { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
  assert.ok(!MONEY.test(a3.text) && calls === 3);

  rows = [base]; fail = true; // 조회 장애: 직전 성공 값이 남아 있어도 쓰지 않는다
  const a4 = await answerQuote(provider, req, NOW);
  assert.deepEqual({ kind: a4.kind, text: a4.text }, { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
  assert.ok(!MONEY.test(a4.text) && calls === 4);

  fail = false; // 복구되면 즉시 다시 안내
  const a5 = await answerQuote(provider, req, NOW);
  assert.ok(a5.text.includes('27,700원') && calls === 5);
});

test('V10 정책을 읽는 모든 서버 경로에 캐시 계층이 없음(데이터 캐시·재검증·정적 라우트·모듈 전역 저장소 금지)', () => {
  const root = path.join(__dirname, '..', '..', 'src');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(root);
  const readers = files.filter((f) => { const s = readFileSync(f, 'utf8'); return s.includes('policy_published') || s.includes('dbPolicyProvider'); });
  assert.ok(readers.length >= 6, `정책 조회 경로 ${readers.length}곳`); // chat·quote·status 라우트, submitLead, dealerPacketDeps, policyFault, publishedPolicies
  const CACHE = /unstable_cache|['"]use cache['"]|\bcacheLife\b|\bcacheTag\b|revalidate\s*[=:(]|force-static|fetchCache|\bnew (Weak)?Map\b|\bReact\.cache\b|from 'react'[^\n]*\bcache\b/;
  for (const f of readers) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!CACHE.test(s), `${path.relative(root, f)}: 캐시 사용 흔적`);
    if (/[\\/]route\.ts$/.test(f)) assert.ok(/export const dynamic = 'force-dynamic'/.test(s), `${path.relative(root, f)}: force-dynamic 필요`);
  }
  // 승인된 정책 화면·API 응답은 no-store
  for (const f of ['server/admin/policyAdmin.ts', 'app/api/consult/quote/route.ts', 'app/api/leads/status/route.ts']) {
    assert.ok(/no-store/.test(readFileSync(path.join(root, f), 'utf8')), `${f}: no-store`);
  }
});
