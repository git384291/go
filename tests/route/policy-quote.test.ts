// 일일 정책 견적 판정 시험. 공급처 코드·숫자는 모두 가상(실제 정책·수수료 아님).
// react-server 조건(test:route)에서 실행: 모듈은 server-only 경계.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { quotePolicy, parseStrictInstant, NEEDS_REVIEW_GUIDANCE } from '../../src/server/policies';
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
    // 모르는 VAT는 known:false로 표현한다. known:true인데 VAT 값이 틀리거나 음수 금액이면 형태 오류(INPUT_INVALID)
    [{ monthlyFee: K({ amountKrw: 11111, vat: 'unknown' as 'included' }) }, 'INPUT_INVALID'],
    [{ installFee: K({ amountKrw: -1, vat: 'included' }) }, 'INPUT_INVALID'],
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
    // PM 11/21 1항: 상담 금액 안내 서버 모듈 1개만 정책 모듈을 읽는다(정확한 allowlist, 화면·API 라우트는 이 모듈을 통해서만)
    const POLICY_USERS = [path.join('src', 'server', 'consult', 'quoteAnswer.ts')];
    if (!f.startsWith(path.join('src', 'server', 'policies')) && !POLICY_USERS.includes(f)) assert.ok(!/server\/policies/.test(s), `${f}: 아직 어떤 화면·API도 정책 모듈에 연결하지 않음`);
  }
});

// ------------------------------------------------------------------ PM 6905713868 회귀

test('Q11 PM 재현 ①: 달력에 없는 날짜(2/31)가 다른 날짜로 정규화되어 견적 근거가 되지 않음', () => {
  const r = quotePolicy([rec({ validFrom: '2026-02-31T00:00:00+09:00', confirmedAt: '2026-02-28T09:00:00+09:00', validUntil: K('2026-03-31T00:00:00+09:00') })], req, new Date('2026-03-03T12:00:00+09:00'));
  assert.deepEqual(reasons(r), ['TIME_FORMAT_INVALID']);
  // 엄격한 시각 해석: 윤년·시분초·오프셋 경계
  for (const ok of ['2028-02-29T00:00:00+09:00', '2026-12-31T23:59:59.999Z', '2026-11-16T12:00+14:00', '2026-11-16T12:00:00-12:00', '2026-11-16T12:00:00.5+09:00'])
    assert.notEqual(parseStrictInstant(ok), null, ok);
  for (const bad of ['2026-02-29T00:00:00+09:00', '2100-02-29T00:00:00Z', '2026-02-31T00:00:00+09:00', '2026-04-31T00:00:00Z', '2026-11-16T24:00:00Z',
    '2026-11-16T12:60:00Z', '2026-11-16T12:00:60Z', '2026-11-16T12:00:00+14:01', '2026-11-16T12:00:00+09:60', '2026-11-16T12:00:00', '2026-11-16',
    '2026-11-16T12:00:00+0900', '2026-11-16T12:00:00.1234Z', ' 2026-11-16T12:00:00Z', '1999-12-31T00:00:00Z', 20261116, null])
    assert.equal(parseStrictInstant(bad), null, String(bad));
  assert.equal(parseStrictInstant('2026-11-16T12:00:00+09:00'), Date.UTC(2026, 10, 16, 3, 0, 0));
  assert.equal(parseStrictInstant('2026-11-16T12:00+14:00'), Date.UTC(2026, 10, 15, 22, 0, 0));
});

test('Q12 PM 재현 ②: 확인 시각이 지금보다 미래면 거부, 사전 공지(시작 전 확인)는 허용, 시각 순서 오류 거부', () => {
  assert.deepEqual(reasons(quotePolicy([rec({ confirmedAt: '2026-11-16T12:00:01+09:00' })], req, NOW)), ['CONFIRMED_IN_FUTURE']);
  assert.equal(quotePolicy([rec({ confirmedAt: '2026-11-15T18:00:00+09:00' })], req, NOW).status, 'quote'); // 시작(16일 0시) 전 확인 = 사전 공지
  assert.equal(quotePolicy([rec({ confirmedAt: '2026-11-16T12:00:00+09:00' })], req, NOW).status, 'quote'); // 확인 = 지금
  assert.deepEqual(reasons(quotePolicy([rec({ validFrom: '2026-11-17T00:00:00+09:00', validUntil: K('2026-11-17T00:00:00+09:00') })], req, new Date('2026-11-17T00:00:00+09:00'))),
    ['EXPIRED', 'TIME_ORDER_INVALID']);
  assert.deepEqual(reasons(quotePolicy([rec({ confirmedAt: '2026-11-15T09:00:00+09:00', validFrom: '2026-11-14T00:00:00+09:00', validUntil: K('2026-11-15T00:00:00+09:00') })], req, NOW)),
    ['EXPIRED', 'TIME_ORDER_INVALID']); // 종료 뒤 확인은 근거 아님
});

test('Q13 PM 재현 ③: 잘못된 Known·null·배열·문자열·enum·식별자는 예외 없이 INPUT_INVALID, 지역 부분 일치 없음', () => {
  const malformed: Partial<Record<keyof PolicyRecord, unknown>>[] = [
    { bundlePrerequisites: { known: true, value: null } }, { bundlePrerequisites: { known: true } }, { bundlePrerequisites: { known: 'yes', value: [] } },
    { bundlePrerequisites: null }, { bundlePrerequisites: K(['ok', 'Bad Code']) }, { bundlePrerequisites: K(['dup', 'dup']) },
    { regionScope: K('region-1,region-2') }, { regionScope: K('nationwidex') }, { regionScope: K([1, 2]) },
    { monthlyFee: K(null) }, { monthlyFee: K({ amountKrw: '11111', vat: 'included' }) }, { monthlyFee: K({ amountKrw: 1.5, vat: 'included' }) },
    { contractMonths: K(37.5) }, { contractMonths: K(-1) }, { contractMonths: K(120) },
    { customerBenefit: K({ amountKrw: 3333, form: 'points', payoutCondition: K('x'), cancellationCondition: K('x') }) },
    { customerBenefit: K({ amountKrw: 3333, form: 'none', payoutCondition: K('x'), cancellationCondition: K('x') }) }, // 금액·형태 모순
    { customerBenefit: K({ amountKrw: 0, form: 'cash', payoutCondition: U, cancellationCondition: U }) },              // 금액·형태 모순
    { customerBenefit: K({ amountKrw: 3333, form: 'cash', payoutCondition: K(''), cancellationCondition: K('x') }) },
    { customerBenefit: K({ amountKrw: 3333, form: 'cash', payoutCondition: K('줄바꿈\n포함'), cancellationCondition: K('x') }) },
    { productLabel: '' }, { productLabel: 'x'.repeat(81) }, { productLabel: 12345 }, { category: 'Internet TV' }, { version: '' }, { version: 'v 1' },
    { sourceKind: 'email' }, { reviewStatus: 'APPROVED' }, { internal: null }, { validUntil: { known: true, value: 20261117 } },
  ];
  for (const patch of malformed) {
    let r: ReturnType<typeof quotePolicy> | undefined;
    assert.doesNotThrow(() => { r = quotePolicy([{ ...base, ...patch }], req, NOW); }, JSON.stringify(patch));
    assert.equal(r!.status, 'needs_review', JSON.stringify(patch));
    assert.ok(['INPUT_INVALID', 'TIME_FORMAT_INVALID'].includes(reasons(r!)[0]), JSON.stringify(patch));
  }
  // 지역은 배열 원소 정확 일치만: 'region-1'을 포함하는 다른 코드로 통과하지 않음
  assert.deepEqual(reasons(quotePolicy([rec({ regionScope: K(['region-10', 'xregion-1']) })], req, NOW)), ['REGION_NOT_COVERED']);
  // 요청 쪽 형태 오류
  for (const badReq of [null, [], { ...req, confirmedBundles: { known: true, value: 'same-carrier-mobile' } }, { ...req, regionCode: undefined }, { ...req, carrier: 7 }])
    assert.deepEqual(reasons(quotePolicy([base], badReq as QuoteRequest, NOW)), ['INPUT_INVALID']);
  // 같은 키 후보 중 하나라도 형태가 틀리면 다른 버전을 고르지 않음
  assert.deepEqual(reasons(quotePolicy([base, { ...base, version: 'v-x', monthlyFee: K(null) } as unknown as PolicyRecord], req, NOW)), ['INPUT_INVALID']);
  // 모름(known:false)과 0의 구분은 유지
  assert.deepEqual(reasons(quotePolicy([rec({ installFee: U })], req, NOW)), ['INSTALL_FEE_UNKNOWN']);
  assert.equal(quotePolicy([rec({ installFee: K({ amountKrw: 0, vat: 'excluded' }) })], req, NOW).status, 'quote');
});

test('Q14 PM 재현 ④: 객체 라벨 등은 DTO에 들어가지 않고, 입력 객체가 동결되지 않음', () => {
  const marker = { secret: 'INTERNAL-MARKER', toString: () => 'x' };
  const evil = { ...base, productLabel: marker } as unknown as PolicyRecord;
  const r = quotePolicy([evil], req, NOW);
  assert.deepEqual(reasons(r), ['INPUT_INVALID']);
  assert.equal(Object.isFrozen(marker), false);
  // 정상 입력도 동결되지 않고 값이 그대로
  const records = [structuredClone(base)];
  const request = structuredClone(req);
  const before = JSON.stringify([records, request]);
  const ok = quotePolicy(records, request, NOW);
  assert.equal(ok.status, 'quote');
  assert.equal(JSON.stringify([records, request]), before);
  const frozenAny = (o: unknown): boolean => !!o && typeof o === 'object' && (Object.isFrozen(o) || Object.values(o).some(frozenAny));
  assert.equal(frozenAny(records) || frozenAny(request), false, '입력 객체가 동결됨');
  // 반환값은 새로 만든 원시값·배열·객체만: 입력의 어떤 하위 객체와도 같은 참조가 아님
  if (ok.status === 'quote') {
    const inputs = new Set<unknown>();
    const collect = (o: unknown) => { if (o && typeof o === 'object') { inputs.add(o); Object.values(o).forEach(collect); } };
    collect(records); collect(request);
    const shared = (o: unknown): boolean => !!o && typeof o === 'object' && (inputs.has(o) || Object.values(o).some(shared));
    assert.equal(shared(ok.quote), false, '입력 객체 참조가 DTO에 남음');
    const leafTypes = new Set<string>();
    const leaves = (o: unknown) => { if (o && typeof o === 'object') Object.values(o).forEach(leaves); else leafTypes.add(o === null ? 'null' : typeof o); };
    leaves(ok.quote);
    for (const ty of leafTypes) assert.ok(['string', 'number', 'null'].includes(ty), ty);
    assert.ok(!JSON.stringify(ok.quote).includes('INTERNAL-MARKER'));
  }
  // 비정상 입력도 값·동결 상태 불변
  const badRecords = [{ ...structuredClone(base), monthlyFee: { known: true, value: null } }];
  const badBefore = JSON.stringify(badRecords);
  quotePolicy(badRecords as unknown as PolicyRecord[], structuredClone(req), NOW);
  assert.equal(JSON.stringify(badRecords), badBefore);
  assert.equal(frozenAny(badRecords), false);
});

test('Q15 거부 결과 키 허용 목록·원문 비노출(형태 오류 포함)', () => {
  const cases = [quotePolicy([{ ...base, productLabel: { secret: 'INTERNAL-MARKER' } } as unknown as PolicyRecord], req, NOW),
    quotePolicy([rec({ confirmedAt: '2027-01-01T00:00:00+09:00' })], req, NOW), quotePolicy([], req, NOW)];
  for (const r of cases) {
    assert.equal(r.status, 'needs_review');
    assert.deepEqual(Object.keys(r).sort(), ['guidance', 'reasons', 'status']);
    assert.ok(!/INTERNAL-MARKER|999999|supplier-a|internal:|11111|TypeError/.test(JSON.stringify(r)));
    assert.ok(Object.isFrozen(r));
  }
});

// ------------------------------------------------------------------ 상담창 안내문(PM 11/21 5항)
import { renderQuoteMessage } from '../../src/server/policies';

test('Q20 안내문: 승인 견적은 요금·사은품·고지만, 공급처·버전·수수료·원문은 없음', () => {
  const m = renderQuoteMessage(quotePolicy([base], req, NOW));
  assert.equal(m.kind, 'quote');
  for (const s of ['11,111원(부가세 포함)', '36개월', '2,222원', '3,333원 상품권', '정책 기준 2026-11-16 09:00', '2026-11-17 00:00까지', '신청 시점에 다시 확인']) assert.ok(m.text.includes(s), s);
  for (const s of ['supplier-a', 'v-fixture-1', '999999', 'internal://', 'sheet-1']) assert.ok(!m.text.includes(s), s);
});

test('Q21 안내문: 검수 필요·미승인·만료는 금액 없이 고정 안내문만', () => {
  const cases = [rec({ reviewStatus: 'draft' }), rec({ validUntil: K('2026-11-16T10:00:00+09:00') }), rec({ monthlyFee: U }), rec({ sourceKind: 'past_promotion' })];
  for (const c of cases) {
    const m = renderQuoteMessage(quotePolicy([c], req, NOW));
    assert.deepEqual(m, { kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
    assert.ok(!/\d{3}/.test(m.text));
  }
});

test('Q22 안내문: 혜택 없음·조건 미상은 확정 표현 없이 표시', () => {
  const none = renderQuoteMessage(quotePolicy([rec({ customerBenefit: K({ amountKrw: 0, form: 'none' as const, payoutCondition: U, cancellationCondition: U }) })], req, NOW));
  assert.ok(none.kind === 'quote' ? none.text.includes('사은품: 없음') : true);
});
