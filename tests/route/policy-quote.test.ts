// 일일 정책 견적 판정 시험. 공급처 코드·숫자는 모두 가상(실제 정책·수수료 아님).
// react-server 조건(test:route)에서 실행: 모듈은 server-only 경계.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { quotePolicy, NEEDS_REVIEW_GUIDANCE } from '../../src/server/policies';
import type { PolicyRecord, QuoteRequest } from '../../src/server/policies';

const NOW = new Date('2026-11-16T12:00:00+09:00');
const K = <T,>(value: T) => ({ known: true as const, value });
const U = { known: false as const };

const base: PolicyRecord = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic',
  productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved',
  confirmedAt: '2026-11-16T09:00:00+09:00', validFrom: '2026-11-16T00:00:00+09:00', validUntil: K('2026-11-17T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36),
  equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([] as string[]), regionScope: K('nationwide' as const),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card' as const, payoutCondition: K('개통 후 확인 절차를 거쳐 지급(가상)'), cancellationCondition: K('약정 기간 내 해지 시 반환(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture/sheet-1' },
};
const req: QuoteRequest = { supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', confirmedBundles: K([] as string[]) };
const reasons = (r: ReturnType<typeof quotePolicy>) => (r.status === 'needs_review' ? r.reasons : []);
const rec = (patch: Partial<PolicyRecord>): PolicyRecord => ({ ...base, ...patch });

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); }
  return o;
}

test('Q1 모든 조건이 확정된 유효 fixture만 견적, 허용 목록 필드만', () => {
  const r = quotePolicy([base], req, NOW);
  assert.equal(r.status, 'quote');
  if (r.status !== 'quote') return;
  assert.deepEqual(Object.keys(r.quote).sort(), ['benefit', 'bundlePrerequisites', 'carrier', 'contractMonths', 'equipmentMonthlyFee', 'generatedAt', 'installFee',
    'monthlyFee', 'notices', 'policyConfirmedAt', 'policyValidUntil', 'productLabel'].sort());
  const text = JSON.stringify(r.quote);
  for (const hidden of ['999999', 'internal://', 'supplier-a', 'v-fixture-1', 'commission', 'sourceRef', 'supplierId', 'version']) assert.ok(!text.includes(hidden), hidden);
  assert.deepEqual(r.quote.monthlyFee, { amountKrw: 11111, vat: 'included' });
  assert.equal(r.quote.benefit.amountKrw, 3333); // 내부 수수료와 더하지 않음
  assert.ok(Object.isFrozen(r.quote) && Object.isFrozen(r.quote.benefit));
});

test('Q2 정책 기준 시각과 생성 시각 구분, 원본 입력 불변', () => {
  const records = deepFreeze([structuredClone(base)]);
  const request = deepFreeze(structuredClone(req));
  const before = JSON.stringify([records, request]);
  const r = quotePolicy(records, request, NOW);
  assert.equal(JSON.stringify([records, request]), before);
  assert.equal(r.status, 'quote');
  if (r.status === 'quote') {
    assert.equal(r.quote.policyConfirmedAt, '2026-11-16T09:00:00+09:00');
    assert.equal(r.quote.generatedAt, NOW.toISOString());
    assert.notEqual(r.quote.policyConfirmedAt, r.quote.generatedAt);
    assert.ok(r.quote.notices.some((n) => n.includes('설치 가능 여부')));
  }
});

test('Q3 다른 공급처·고객군의 같은 통신사 정책은 섞지 않고, 수수료로 고르지 않음', () => {
  const otherSupplier = rec({ supplierId: 'supplier-b', monthlyFee: K({ amountKrw: 1, vat: 'included' }), internal: { commissionKrw: 9_000_000, sourceRef: null } });
  const otherSegment = rec({ segment: 'soho', monthlyFee: K({ amountKrw: 2, vat: 'included' }) });
  const r = quotePolicy([otherSupplier, otherSegment, base], req, NOW);
  assert.equal(r.status, 'quote');
  if (r.status === 'quote') assert.equal(r.quote.monthlyFee.amountKrw, 11111);
  assert.deepEqual(reasons(quotePolicy([otherSupplier, otherSegment], req, NOW)), ['NO_POLICY']);
  assert.deepEqual(reasons(quotePolicy([base], { ...req, segment: 'soho' }, NOW)), ['NO_POLICY']);
});

test('Q4 만료·미래·기간 미상·오프셋 없는 시각은 확정 견적 거부(임의 하루 끝을 만들지 않음)', () => {
  assert.deepEqual(reasons(quotePolicy([rec({ validUntil: K('2026-11-16T12:00:00+09:00') })], req, NOW)), ['EXPIRED']); // 종료 시각 = 지금
  assert.deepEqual(reasons(quotePolicy([rec({ validFrom: '2026-11-16T12:00:01+09:00' })], req, NOW)), ['NOT_YET_VALID']);
  assert.deepEqual(reasons(quotePolicy([rec({ validUntil: U })], req, NOW)), ['VALIDITY_UNKNOWN']);
  assert.deepEqual(reasons(quotePolicy([rec({ validUntil: K('2026-11-17') })], req, NOW)), ['TIME_FORMAT_INVALID']);
  assert.deepEqual(reasons(quotePolicy([rec({ validFrom: '2026-11-16T00:00:00' })], req, NOW)), ['TIME_FORMAT_INVALID']);
  assert.deepEqual(reasons(quotePolicy([rec({ confirmedAt: null })], req, NOW)), ['CONFIRMED_AT_UNKNOWN']);
  // 같은 정책도 시각 주입에 따라 판정이 바뀐다(Asia/Seoul 오프셋 기준 절대 시각)
  assert.equal(quotePolicy([base], req, new Date('2026-11-16T23:59:59+09:00')).status, 'quote');
  assert.deepEqual(reasons(quotePolicy([base], req, new Date('2026-11-17T00:00:00+09:00'))), ['EXPIRED']);
});

test('Q5 교육자료·과거 프로모션·미확인 캡처·미검수·반려·대체 버전은 거부', () => {
  for (const sourceKind of ['training_material', 'past_promotion', 'unverified_screenshot'] as const) {
    assert.deepEqual(reasons(quotePolicy([rec({ sourceKind })], req, NOW)), ['SOURCE_NOT_QUOTABLE'], sourceKind);
  }
  for (const reviewStatus of ['draft', 'rejected', 'superseded'] as const) {
    assert.deepEqual(reasons(quotePolicy([rec({ reviewStatus })], req, NOW)), ['NOT_APPROVED'], reviewStatus);
  }
  // 대체된 버전과 승인 버전이 함께 있으면 승인·유효한 것 하나만 쓴다
  const r = quotePolicy([rec({ reviewStatus: 'superseded', version: 'v0', monthlyFee: K({ amountKrw: 5, vat: 'included' }) }), base], req, NOW);
  assert.equal(r.status, 'quote');
});

test('Q6 같은 키에 유효·승인 버전이 둘 이상이면 고르지 않음(상충)', () => {
  const v2 = rec({ version: 'v-fixture-2', monthlyFee: K({ amountKrw: 22222, vat: 'included' }) });
  assert.deepEqual(reasons(quotePolicy([base, v2], req, NOW)), ['CONFLICTING_VERSIONS']);
  assert.deepEqual(reasons(quotePolicy([base, rec({})], req, NOW)), ['CONFLICTING_VERSIONS']); // 같은 값이어도 중복은 확인 필요
});

test('Q7 0과 unknown 구분: 확인된 0은 견적, 모름은 확인 필요', () => {
  const zero = quotePolicy([rec({ installFee: K({ amountKrw: 0, vat: 'included' }), customerBenefit: K({ amountKrw: 0, form: 'none' as const, payoutCondition: U, cancellationCondition: U }) })], req, NOW);
  assert.equal(zero.status, 'quote');
  if (zero.status === 'quote') { assert.equal(zero.quote.installFee.amountKrw, 0); assert.equal(zero.quote.benefit.payoutCondition, null); }
  const cases: [Partial<PolicyRecord>, string][] = [
    [{ monthlyFee: U }, 'MONTHLY_FEE_UNKNOWN'], [{ contractMonths: U }, 'CONTRACT_UNKNOWN'], [{ equipmentMonthlyFee: U }, 'EQUIPMENT_FEE_UNKNOWN'],
    [{ installFee: U }, 'INSTALL_FEE_UNKNOWN'], [{ bundlePrerequisites: U }, 'BUNDLE_TERMS_UNKNOWN'], [{ regionScope: U }, 'REGION_TERMS_UNKNOWN'],
    [{ customerBenefit: U }, 'BENEFIT_UNKNOWN'],
    [{ monthlyFee: K({ amountKrw: 11111, vat: 'unknown' as 'included' }) }, 'MONTHLY_FEE_UNKNOWN'], // VAT 미상
    [{ installFee: K({ amountKrw: -1, vat: 'included' }) }, 'INSTALL_FEE_UNKNOWN'],
    [{ customerBenefit: K({ amountKrw: 3333, form: 'cash' as const, payoutCondition: U, cancellationCondition: K('x') }) }, 'BENEFIT_CONDITIONS_UNKNOWN'],
    [{ customerBenefit: K({ amountKrw: 3333, form: 'cash' as const, payoutCondition: K('x'), cancellationCondition: U }) }, 'BENEFIT_CONDITIONS_UNKNOWN'],
  ];
  for (const [patch, code] of cases) assert.deepEqual(reasons(quotePolicy([rec(patch)], req, NOW)), [code], code);
});

test('Q8 결합 전제·지역: 미확인이면 fail-closed', () => {
  const needsMobile = rec({ bundlePrerequisites: K(['same-carrier-mobile']) });
  assert.deepEqual(reasons(quotePolicy([needsMobile], req, NOW)), ['BUNDLE_UNCONFIRMED']);
  assert.deepEqual(reasons(quotePolicy([needsMobile], { ...req, confirmedBundles: U }, NOW)), ['BUNDLE_UNCONFIRMED']);
  assert.equal(quotePolicy([needsMobile], { ...req, confirmedBundles: K(['same-carrier-mobile']) }, NOW).status, 'quote');
  assert.deepEqual(reasons(quotePolicy([base], { ...req, regionCode: null }, NOW)), ['REGION_UNCONFIRMED']);
  assert.deepEqual(reasons(quotePolicy([rec({ regionScope: K(['region-2']) })], req, NOW)), ['REGION_NOT_COVERED']);
  assert.equal(quotePolicy([rec({ regionScope: K(['region-1', 'region-2']) })], req, NOW).status, 'quote');
});

test('Q9 비활성 상품 분류·잘못된 입력은 거부, 이유와 사람 확인 안내만 반환', () => {
  for (const category of ['cctv_security', 'mobile', 'internet_phone', 'unknown_category']) {
    assert.deepEqual(reasons(quotePolicy([rec({ category })], req, NOW)), ['PRODUCT_NOT_ACTIVE'], category);
  }
  for (const bad of [{ ...req, supplierId: 'Supplier A' }, { ...req, segment: 'enterprise' as 'sme' }, { ...req, regionCode: '<x>' }]) {
    assert.deepEqual(reasons(quotePolicy([base], bad, NOW)), ['INPUT_INVALID']);
  }
  assert.deepEqual(reasons(quotePolicy([base], req, new Date('invalid'))), ['INPUT_INVALID']);
  const r = quotePolicy([rec({ monthlyFee: U, installFee: U })], req, NOW);
  assert.equal(r.status, 'needs_review');
  if (r.status === 'needs_review') {
    assert.deepEqual(Object.keys(r).sort(), ['guidance', 'reasons', 'status']);
    assert.equal(r.guidance, NEEDS_REVIEW_GUIDANCE);
    assert.ok(!JSON.stringify(r).match(/11111|999999|supplier-a|internal/));
  }
});

test('Q10 경계: 모든 런타임 파일이 server-only, 클라이언트 파일은 정책 모듈을 import하지 않음, 승인 상태를 쓰는 경로 없음', () => {
  for (const f of readdirSync('src/server/policies')) {
    const s = readFileSync(path.join('src/server/policies', f), 'utf8');
    assert.match(s, /^import 'server-only';/, f);
    assert.ok(!/reviewStatus\s*=|\.reviewStatus\s*=\s*'approved'/.test(s), `${f}: 검수 상태를 설정하는 코드`);
  }
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(n) ? [p] : [];
  });
  for (const f of walk('src')) {
    const s = readFileSync(f, 'utf8');
    if (/^['"]use client['"]/.test(s.trimStart())) assert.ok(!/server\/policies/.test(s), `${f}: 클라이언트 파일이 정책 모듈 import`);
    if (!f.startsWith(path.join('src', 'server', 'policies'))) assert.ok(!/server\/policies/.test(s), `${f}: 아직 어떤 화면·API도 정책 모듈에 연결하지 않음`);
  }
});
