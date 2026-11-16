import 'server-only';
import { isActiveInterest } from '../../content/catalog';
import type { CustomerQuote, Known, PolicyRecord, QuoteRequest, QuoteResult, ReasonCode, SourceKind } from './types';

/**
 * 견적 판정(순수 함수). 하나라도 확정되지 않으면 견적이 아니라 '확인 필요'와 이유 코드를 돌려준다(fail-closed).
 * - 현재 시각은 주입한다(now). 시각 문자열은 오프셋(Z 또는 ±hh:mm)이 있어야 한다 → 하루 끝·새 정책일을 임의로 만들지 않음.
 * - 같은 키(공급처·고객군·통신사·상품)의 레코드만 본다. 다른 공급처·고객군은 섞지 않고, 수수료로 고르지 않는다.
 * - 입력 객체를 바꾸지 않는다. 고객 견적은 허용 목록 필드로 새로 만든다.
 */
export const QUOTABLE_SOURCES: readonly SourceKind[] = ['official_policy_sheet', 'distributor_notice'];
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEGMENTS = ['household', 'soho', 'sme'];

export const NEEDS_REVIEW_GUIDANCE = '담당자가 당일 정책과 조건을 직접 확인한 뒤 안내합니다. 확인 전에는 요금·혜택을 확정해 안내하지 않습니다.';
export const QUOTE_NOTICES: readonly string[] = Object.freeze([
  '설치 가능 여부와 장비 재고는 주소 확인 후 통신사가 최종 확정합니다.',
  '요금·혜택은 표시된 정책 기준 시각의 조건이며, 신청 시점에 다시 확인합니다.',
]);

const instant = (iso: unknown): number | null => (typeof iso === 'string' && ISO_WITH_OFFSET.test(iso) && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null);
const isKrw = (v: unknown) => !!v && typeof v === 'object' && Number.isSafeInteger((v as { amountKrw: unknown }).amountKrw) && (v as { amountKrw: number }).amountKrw >= 0
  && ((v as { vat: unknown }).vat === 'included' || (v as { vat: unknown }).vat === 'excluded');
const knownValue = <T>(k: Known<T> | undefined): k is { known: true; value: T } => !!k && k.known === true && 'value' in k;

function validRequest(r: QuoteRequest): boolean {
  return !!r && CODE.test(r.supplierId) && SEGMENTS.includes(r.segment) && CODE.test(r.carrier) && CODE.test(r.productId)
    && (r.regionCode === null || CODE.test(r.regionCode)) && !!r.confirmedBundles && typeof r.confirmedBundles.known === 'boolean';
}

/** 레코드 단위 판정: 출처·검수·시각. 통과하면 [] */
function recordGate(p: PolicyRecord, now: number): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (p.reviewStatus !== 'approved') reasons.push('NOT_APPROVED');
  if (!QUOTABLE_SOURCES.includes(p.sourceKind)) reasons.push('SOURCE_NOT_QUOTABLE');
  if (p.confirmedAt === null) reasons.push('CONFIRMED_AT_UNKNOWN');
  else if (instant(p.confirmedAt) === null) reasons.push('TIME_FORMAT_INVALID');
  const from = instant(p.validFrom);
  if (from === null) reasons.push('TIME_FORMAT_INVALID');
  else if (now < from) reasons.push('NOT_YET_VALID');
  if (!knownValue(p.validUntil)) reasons.push('VALIDITY_UNKNOWN');
  else {
    const until = instant(p.validUntil.value);
    if (until === null) reasons.push('TIME_FORMAT_INVALID');
    else if (now >= until) reasons.push('EXPIRED');
  }
  return reasons;
}

/** 조건 판정: 필수 금액·약정·결합·지역·혜택. 통과하면 [] */
function termsGate(p: PolicyRecord, req: QuoteRequest): ReasonCode[] {
  const r: ReasonCode[] = [];
  if (!isActiveInterest(p.category)) r.push('PRODUCT_NOT_ACTIVE');
  if (!knownValue(p.monthlyFee) || !isKrw(p.monthlyFee.value)) r.push('MONTHLY_FEE_UNKNOWN');
  if (!knownValue(p.contractMonths) || !Number.isSafeInteger(p.contractMonths.value) || p.contractMonths.value < 0) r.push('CONTRACT_UNKNOWN');
  if (!knownValue(p.equipmentMonthlyFee) || !isKrw(p.equipmentMonthlyFee.value)) r.push('EQUIPMENT_FEE_UNKNOWN');
  if (!knownValue(p.installFee) || !isKrw(p.installFee.value)) r.push('INSTALL_FEE_UNKNOWN');
  if (!knownValue(p.bundlePrerequisites)) r.push('BUNDLE_TERMS_UNKNOWN');
  else if (p.bundlePrerequisites.value.length > 0) {
    if (!knownValue(req.confirmedBundles) || !p.bundlePrerequisites.value.every((b) => (req.confirmedBundles as { value: readonly string[] }).value.includes(b))) r.push('BUNDLE_UNCONFIRMED');
  }
  if (!knownValue(p.regionScope)) r.push('REGION_TERMS_UNKNOWN');
  else if (req.regionCode === null) r.push('REGION_UNCONFIRMED');
  else if (p.regionScope.value !== 'nationwide' && !p.regionScope.value.includes(req.regionCode)) r.push('REGION_NOT_COVERED');
  if (!knownValue(p.customerBenefit)) r.push('BENEFIT_UNKNOWN');
  else {
    const b = p.customerBenefit.value;
    if (!Number.isSafeInteger(b.amountKrw) || b.amountKrw < 0) r.push('BENEFIT_UNKNOWN');
    else if (b.amountKrw > 0 && (!knownValue(b.payoutCondition) || !knownValue(b.cancellationCondition))) r.push('BENEFIT_CONDITIONS_UNKNOWN');
  }
  return r;
}

const review = (reasons: ReasonCode[]): QuoteResult => ({
  status: 'needs_review',
  reasons: Object.freeze([...new Set(reasons)].sort()) as readonly ReasonCode[],
  guidance: NEEDS_REVIEW_GUIDANCE,
});

const copyKrw = (k: { amountKrw: number; vat: 'included' | 'excluded' }) => ({ amountKrw: k.amountKrw, vat: k.vat });

export function quotePolicy(records: readonly PolicyRecord[], req: QuoteRequest, now: Date): QuoteResult {
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Array.isArray(records) || !Number.isFinite(t) || !validRequest(req)) return review(['INPUT_INVALID']);

  // 같은 키만(공급처·고객군·통신사·상품). 다른 공급처·고객군의 같은 통신사 정책은 보지 않는다.
  const same = records.filter((p) => p && p.supplierId === req.supplierId && p.segment === req.segment && p.carrier === req.carrier && p.productId === req.productId);
  if (same.length === 0) return review(['NO_POLICY']);

  const gated = same.map((p) => ({ p, reasons: recordGate(p, t) }));
  const usable = gated.filter((g) => g.reasons.length === 0);
  if (usable.length === 0) return review(gated.flatMap((g) => g.reasons));
  if (usable.length > 1) return review(['CONFLICTING_VERSIONS']); // 같은 키에 유효·승인 버전이 둘 이상이면 고르지 않는다

  const p = usable[0].p;
  const terms = termsGate(p, req);
  if (terms.length) return review(terms);

  const b = (p.customerBenefit as { value: { amountKrw: number; form: CustomerQuote['benefit']['form']; payoutCondition: Known<string>; cancellationCondition: Known<string> } }).value;
  const quote: CustomerQuote = {
    carrier: p.carrier,
    productLabel: p.productLabel,
    monthlyFee: copyKrw((p.monthlyFee as { value: { amountKrw: number; vat: 'included' | 'excluded' } }).value),
    contractMonths: (p.contractMonths as { value: number }).value,
    equipmentMonthlyFee: copyKrw((p.equipmentMonthlyFee as { value: { amountKrw: number; vat: 'included' | 'excluded' } }).value),
    installFee: copyKrw((p.installFee as { value: { amountKrw: number; vat: 'included' | 'excluded' } }).value),
    bundlePrerequisites: [...(p.bundlePrerequisites as { value: readonly string[] }).value],
    benefit: {
      amountKrw: b.amountKrw,
      form: b.form,
      payoutCondition: knownValue(b.payoutCondition) ? b.payoutCondition.value : null,
      cancellationCondition: knownValue(b.cancellationCondition) ? b.cancellationCondition.value : null,
    },
    policyConfirmedAt: p.confirmedAt as string,
    policyValidUntil: (p.validUntil as { value: string }).value,
    generatedAt: new Date(t).toISOString(),
    notices: [...QUOTE_NOTICES],
  };
  return { status: 'quote', quote: deepFreeze(quote) };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
