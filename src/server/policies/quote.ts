import 'server-only';
import { isActiveInterest } from '../../content/catalog';
import type { CustomerQuote, QuoteRequest, QuoteResult, ReasonCode, SourceKind } from './types';

/**
 * 견적 판정(순수 함수). 계약: docs/POLICY-QUOTING-CONTRACT.md
 * - 입력을 타입 선언으로 믿지 않는다. 실행 시점에 모든 필드를 검사해 원시값·새 배열로 된 '정규화 사본'을 만든 뒤 판정한다.
 *   형태가 틀리면 INPUT_INVALID(원문 값·오류는 넣지 않음). Known의 known:false는 '모름'으로 0과 구분한다.
 * - 시각은 엄격한 ISO(달력·윤년·시분초·오프셋 직접 검증)만 받는다. Date.parse의 날짜 정규화(2/31 → 3/3)를 쓰지 않는다.
 * - 현재 시각은 주입한다. 하루 끝·새 정책일을 임의로 만들지 않는다.
 * - 같은 키(공급처·고객군·통신사·상품)만 본다. 다른 공급처·고객군을 섞지 않고 수수료로 고르지 않는다.
 * - 입력 객체를 바꾸거나 동결하지 않는다. 고객 견적은 정규화 사본에서 새로 만든 값만 담고, 새로 만든 것만 동결한다.
 */
export const QUOTABLE_SOURCES: readonly SourceKind[] = Object.freeze(['official_policy_sheet', 'distributor_notice'] as const);
export const NEEDS_REVIEW_GUIDANCE = '담당자가 당일 정책과 조건을 직접 확인한 뒤 안내합니다. 확인 전에는 요금·혜택을 확정해 안내하지 않습니다.';
export const QUOTE_NOTICES: readonly string[] = Object.freeze([
  '설치 가능 여부와 장비 재고는 주소 확인 후 통신사가 최종 확정합니다.',
  '요금·혜택은 표시된 정책 기준 시각의 조건이며, 신청 시점에 다시 확인합니다.',
]);

const SEGMENTS = ['household', 'soho', 'sme'] as const;
const SOURCES = ['official_policy_sheet', 'distributor_notice', 'training_material', 'past_promotion', 'unverified_screenshot'] as const;
const REVIEW = ['draft', 'approved', 'rejected', 'superseded'] as const;
const VATS = ['included', 'excluded'] as const;
const FORMS = ['gift_card', 'cash', 'bill_discount', 'none'] as const;
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CATEGORY = /^[a-z][a-z_]{0,31}$/;
const MAX_KRW = 10_000_000_000;
const MAX_LIST = 50;

type Krw = { amountKrw: number; vat: (typeof VATS)[number] };
type K<T> = { known: true; value: T } | { known: false };
type Benefit = { amountKrw: number; form: (typeof FORMS)[number]; payoutCondition: K<string>; cancellationCondition: K<string> };
type Rec = {
  supplierId: string; segment: string; carrier: string; productId: string; productLabel: string; category: string; version: string;
  sourceKind: (typeof SOURCES)[number]; reviewStatus: (typeof REVIEW)[number];
  confirmedAt: number | null; confirmedAtText: string | null; validFrom: number; validUntil: K<number>; validUntilText: string | null;
  monthlyFee: K<Krw>; contractMonths: K<number>; equipmentMonthlyFee: K<Krw>; installFee: K<Krw>;
  bundlePrerequisites: K<string[]>; regionScope: K<string[] | 'nationwide'>; customerBenefit: K<Benefit>;
};
type Req = { supplierId: string; segment: string; carrier: string; productId: string; regionCode: string | null; confirmedBundles: K<string[]> };

class Invalid extends Error {
  constructor(readonly reason: 'INPUT_INVALID' | 'TIME_FORMAT_INVALID' = 'INPUT_INVALID') { super(reason); }
}
const bad = (): never => { throw new Invalid(); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : bad());
const code = (v: unknown): string => (typeof v === 'string' && CODE.test(v) ? v : bad());
/** 고객 안내 문자열: 1~200자, 제어 문자 없음. (내용의 정확성·개인정보 여부는 이 검사로 보장하지 않는다) */
const text = (v: unknown, max = 200): string => (typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : bad());
const int = (v: unknown, min: number, max: number): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad());
const krw = (v: unknown): Krw => (isObj(v) ? { amountKrw: int(v.amountKrw, 0, MAX_KRW), vat: oneOf(VATS, v.vat) } : bad());
const codeList = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length > MAX_LIST) return bad();
  const out = v.map(code);
  return new Set(out).size === out.length ? out : bad();
};
/** Known 구조 검사: known은 boolean, known:true면 value를 검사한 새 값 */
function known<T>(v: unknown, parse: (x: unknown) => T): K<T> {
  if (!isObj(v) || typeof v.known !== 'boolean') return bad();
  if (!v.known) return { known: false };
  if (!('value' in v)) return bad();
  return { known: true, value: parse(v.value) };
}

/**
 * 엄격한 ISO 8601 시각(오프셋 필수) → epoch ms. 달력·윤년·시분초·밀리초·오프셋 범위를 직접 검증한다.
 * 형식이 틀리면 null(정규화해서 다른 날짜로 바꾸지 않는다).
 */
export function parseStrictInstant(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > dim) return null;
  let off = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[10]), om = Number(m[11]);
    if (om > 59 || oh > 14 || (oh === 14 && om > 0)) return null;
    off = (m[9] === '+' ? 1 : -1) * (oh * 60 + om);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - off * 60_000;
}
const instant = (v: unknown): number => {
  const t = parseStrictInstant(v);
  if (t === null) throw new Invalid('TIME_FORMAT_INVALID');
  return t;
};

function parseRecord(raw: unknown): Rec {
  if (!isObj(raw)) return bad();
  if (!isObj(raw.internal)) return bad(); // 내부 필드는 형태만 확인하고 읽어 쓰지 않는다
  const validUntilKnown = known(raw.validUntil, (x) => (typeof x === 'string' ? x : bad()));
  const benefit = known(raw.customerBenefit, (b): Benefit => {
    if (!isObj(b)) return bad();
    const amountKrw = int(b.amountKrw, 0, MAX_KRW);
    const form = oneOf(FORMS, b.form);
    if ((form === 'none') !== (amountKrw === 0)) return bad(); // 금액·형태 모순
    return { amountKrw, form, payoutCondition: known(b.payoutCondition, (x) => text(x)), cancellationCondition: known(b.cancellationCondition, (x) => text(x)) };
  });
  return {
    supplierId: code(raw.supplierId), segment: oneOf(SEGMENTS, raw.segment), carrier: code(raw.carrier), productId: code(raw.productId),
    productLabel: text(raw.productLabel, 80),
    category: typeof raw.category === 'string' && CATEGORY.test(raw.category) ? raw.category : bad(),
    version: typeof raw.version === 'string' && VERSION.test(raw.version) ? raw.version : bad(),
    sourceKind: oneOf(SOURCES, raw.sourceKind), reviewStatus: oneOf(REVIEW, raw.reviewStatus),
    confirmedAt: raw.confirmedAt === null ? null : instant(raw.confirmedAt),
    confirmedAtText: typeof raw.confirmedAt === 'string' ? raw.confirmedAt : null,
    validFrom: instant(raw.validFrom),
    validUntil: validUntilKnown.known ? { known: true, value: instant(validUntilKnown.value) } : { known: false },
    validUntilText: validUntilKnown.known ? validUntilKnown.value : null,
    monthlyFee: known(raw.monthlyFee, krw),
    contractMonths: known(raw.contractMonths, (x) => int(x, 0, 60)),
    equipmentMonthlyFee: known(raw.equipmentMonthlyFee, krw),
    installFee: known(raw.installFee, krw),
    bundlePrerequisites: known(raw.bundlePrerequisites, codeList),
    regionScope: known(raw.regionScope, (x) => (x === 'nationwide' ? 'nationwide' as const : codeList(x))), // 문자열은 'nationwide'만, 그 외 배열만(부분 일치 경로 없음)
    customerBenefit: benefit,
  };
}

function parseRequest(raw: unknown): Req {
  if (!isObj(raw)) return bad();
  return {
    supplierId: code(raw.supplierId), segment: oneOf(SEGMENTS, raw.segment), carrier: code(raw.carrier), productId: code(raw.productId),
    regionCode: raw.regionCode === null ? null : code(raw.regionCode),
    confirmedBundles: known(raw.confirmedBundles, codeList),
  };
}

/** 키 필드만 안전하게 읽어 같은 키인지 본다(나머지는 parseRecord가 검사) */
const sameKey = (raw: unknown, q: Req) => isObj(raw) && raw.supplierId === q.supplierId && raw.segment === q.segment && raw.carrier === q.carrier && raw.productId === q.productId;

/** 레코드 단위 판정: 출처·검수·시각과 시각 관계. 통과하면 [] */
function recordGate(p: Rec, now: number): ReasonCode[] {
  const r: ReasonCode[] = [];
  if (p.reviewStatus !== 'approved') r.push('NOT_APPROVED');
  if (!QUOTABLE_SOURCES.includes(p.sourceKind)) r.push('SOURCE_NOT_QUOTABLE');
  if (p.confirmedAt === null) r.push('CONFIRMED_AT_UNKNOWN');
  else if (p.confirmedAt > now) r.push('CONFIRMED_IN_FUTURE'); // 아직 확인하지 않은 시각으로 견적을 만들지 않는다
  if (now < p.validFrom) r.push('NOT_YET_VALID');
  if (!p.validUntil.known) r.push('VALIDITY_UNKNOWN');
  else {
    if (p.validUntil.value <= p.validFrom) r.push('TIME_ORDER_INVALID');
    if (p.confirmedAt !== null && p.confirmedAt >= p.validUntil.value) r.push('TIME_ORDER_INVALID'); // 종료 뒤 확인은 근거가 아님(사전 공지 = 시작 전 확인은 허용)
    if (now >= p.validUntil.value) r.push('EXPIRED');
  }
  return r;
}

/** 조건 판정: 필수 금액·약정·결합·지역·혜택. 통과하면 [] */
function termsGate(p: Rec, q: Req): ReasonCode[] {
  const r: ReasonCode[] = [];
  if (!isActiveInterest(p.category)) r.push('PRODUCT_NOT_ACTIVE');
  if (!p.monthlyFee.known) r.push('MONTHLY_FEE_UNKNOWN');
  if (!p.contractMonths.known) r.push('CONTRACT_UNKNOWN');
  if (!p.equipmentMonthlyFee.known) r.push('EQUIPMENT_FEE_UNKNOWN');
  if (!p.installFee.known) r.push('INSTALL_FEE_UNKNOWN');
  if (!p.bundlePrerequisites.known) r.push('BUNDLE_TERMS_UNKNOWN');
  else if (p.bundlePrerequisites.value.length > 0) {
    const have = q.confirmedBundles.known ? q.confirmedBundles.value : null;
    if (!have || !p.bundlePrerequisites.value.every((b) => have.includes(b))) r.push('BUNDLE_UNCONFIRMED');
  }
  if (!p.regionScope.known) r.push('REGION_TERMS_UNKNOWN');
  else if (q.regionCode === null) r.push('REGION_UNCONFIRMED');
  else if (p.regionScope.value !== 'nationwide' && !p.regionScope.value.includes(q.regionCode)) r.push('REGION_NOT_COVERED'); // 배열 원소 정확 일치
  if (!p.customerBenefit.known) r.push('BENEFIT_UNKNOWN');
  else if (p.customerBenefit.value.amountKrw > 0 && (!p.customerBenefit.value.payoutCondition.known || !p.customerBenefit.value.cancellationCondition.known)) {
    r.push('BENEFIT_CONDITIONS_UNKNOWN');
  }
  return r;
}

const review = (reasons: ReasonCode[]): QuoteResult => Object.freeze({
  status: 'needs_review' as const,
  reasons: Object.freeze([...new Set(reasons)].sort()),
  guidance: NEEDS_REVIEW_GUIDANCE,
});

export function quotePolicy(records: readonly unknown[], request: QuoteRequest | unknown, now: Date): QuoteResult {
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Array.isArray(records) || !Number.isFinite(t)) return review(['INPUT_INVALID']);
  let q: Req;
  try { q = parseRequest(request); } catch { return review(['INPUT_INVALID']); }

  const same = records.filter((raw) => sameKey(raw, q));
  if (same.length === 0) return review(['NO_POLICY']);

  // 같은 키 후보는 모두 형태를 검사한다. 하나라도 형태가 틀리면 그 키는 확인 필요(틀린 후보를 건너뛰고 다른 버전을 고르지 않음)
  let parsed: Rec[];
  try { parsed = same.map(parseRecord); } catch (e) { return review([e instanceof Invalid ? e.reason : 'INPUT_INVALID']); }

  const gated = parsed.map((p) => ({ p, reasons: recordGate(p, t) }));
  const usable = gated.filter((g) => g.reasons.length === 0);
  if (usable.length === 0) return review(gated.flatMap((g) => g.reasons));
  if (usable.length > 1) return review(['CONFLICTING_VERSIONS']);

  const p = usable[0].p;
  const terms = termsGate(p, q);
  if (terms.length) return review(terms);

  // 아래 값은 terms 통과로 모두 known. 정규화 사본(원시값·새 배열)에서 새 객체를 만든다.
  if (!(p.monthlyFee.known && p.contractMonths.known && p.equipmentMonthlyFee.known && p.installFee.known && p.bundlePrerequisites.known
    && p.customerBenefit.known && p.validUntil.known && p.confirmedAtText !== null && p.validUntilText !== null)) return review(['INPUT_INVALID']);
  const b = p.customerBenefit.value;
  const quote: CustomerQuote = {
    carrier: p.carrier,
    productLabel: p.productLabel,
    monthlyFee: Object.freeze({ amountKrw: p.monthlyFee.value.amountKrw, vat: p.monthlyFee.value.vat }),
    contractMonths: p.contractMonths.value,
    equipmentMonthlyFee: Object.freeze({ amountKrw: p.equipmentMonthlyFee.value.amountKrw, vat: p.equipmentMonthlyFee.value.vat }),
    installFee: Object.freeze({ amountKrw: p.installFee.value.amountKrw, vat: p.installFee.value.vat }),
    bundlePrerequisites: Object.freeze([...p.bundlePrerequisites.value]),
    benefit: Object.freeze({
      amountKrw: b.amountKrw,
      form: b.form,
      payoutCondition: b.payoutCondition.known ? b.payoutCondition.value : null,
      cancellationCondition: b.cancellationCondition.known ? b.cancellationCondition.value : null,
    }),
    policyConfirmedAt: p.confirmedAtText,
    policyValidUntil: p.validUntilText,
    generatedAt: new Date(t).toISOString(),
    notices: Object.freeze([...QUOTE_NOTICES]),
  };
  return Object.freeze({ status: 'quote' as const, quote: Object.freeze(quote) });
}
