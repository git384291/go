/**
 * 광고 지표 순수 계산(PHASE 1: 계산·검증만). 수집·추적·외부 전송·DB 저장 없음.
 *
 * 집계 모델(입력의 model로 명시, 섞지 않음)
 * - cohort(동일 유입 코호트): 기간 안에 유입(클릭·방문)된 사람들을 기준으로, 유입 뒤 windowDays 안에 일어난 전환·매출만 센다.
 *   같은 사람들의 단계별 수이므로 '상담 접수 ≥ 가입 ≥ 개통 ≥ 정산'이어야 한다(아니면 입력 오류). ROAS는 이 모델에서만 계산한다.
 * - occurrence(기간 발생 집계): 기간 안에 '일어난' 전환 수. 지난달 접수가 이번달 개통될 수 있으므로 단계 간 크기 비교를 하지 않는다.
 *   귀속이 없으므로 ROAS는 null(기간 매출 ÷ 기간 비용을 ROAS로 부르지 않는다).
 *
 * 원칙
 * - 금액은 원 단위 정수. 분모 0·미수집·연동 안 됨은 0%가 아니라 null(미확인).
 * - 매출은 실제 인정된 판매 수수료(환수·취소 차감, 음수 가능)만. 통신사 월요금·고객 계약액·개당 예상 마진은 매출이 아니다.
 * - 자연 검색과 유료 광고를 섞지 않는다. CPI는 앱 설치 캠페인이 없어 해당 없음.
 * - 타입 선언을 믿지 않고 실행 시점에 모든 필드를 검증한다(누락·잘못된 값은 계산하지 않고 거부).
 */
export const CONVERSION_STAGES = ['consult_request', 'signup', 'activation', 'settlement'] as const;
export const TRAFFIC_KINDS = ['paid', 'organic', 'direct', 'referral'] as const;
export const AD_FORMATS = ['search', 'display', 'social', 'other'] as const; // SA=search, DA=display
export const MODELS = ['cohort', 'occurrence'] as const;

export type ConversionStage = (typeof CONVERSION_STAGES)[number];
export type TrafficKind = (typeof TRAFFIC_KINDS)[number];
export type AdFormat = (typeof AD_FORMATS)[number];
export type AggregationModel = (typeof MODELS)[number];

/** 귀속 창 최대 일수. 0일 귀속은 의미가 모호해 허용하지 않는다(같은 날도 1일 창으로 표현) */
export const MAX_WINDOW_DAYS = 365;
/** 금액 상한(원): 안전 정수 범위 안에서 현실적인 최대값 */
export const MAX_AMOUNT_KRW = 1_000_000_000_000;

export type MetricInput = {
  model: AggregationModel;
  period: { from: string; to: string }; // YYYY-MM-DD, Asia/Seoul, 달력상 유효한 날짜
  /** cohort: 유입 뒤 전환·매출을 세는 일수(1~365). occurrence: null */
  windowDays: number | null;
  source: string; // 등록된 비식별 출처 코드
  traffic: TrafficKind;
  format: AdFormat | null;
  spendKrw: number | null;
  spendIncludesVat: boolean | null;
  impressions: number | null;
  clicks: number | null;
  visits: number | null;
  conversions: Partial<Record<ConversionStage, number | null>>;
  /** 실제 인정된 판매 수수료(원), 환수·취소 차감 후. cohort에서만 의미 */
  recognizedRevenueKrw: number | null;
};

export type Metrics = {
  model: AggregationModel;
  cpm: number | null; cpc: number | null; ctr: number | null;
  cpa: Partial<Record<ConversionStage, number | null>>;
  cvr: Partial<Record<ConversionStage, number | null>>;
  cvrDenominator: 'clicks' | 'visits';
  roas: number | null;
  cpi: 'not_applicable';
};

export class MetricInputError extends Error {}
const fail = (code: string): never => { throw new MetricInputError(code); };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isCountOrNull = (v: unknown) => v === null || isCount(v);

/** 달력상 유효한 YYYY-MM-DD(윤년 포함) */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 실행 시점 전체 검증. 통과하면 MetricInput으로 쓸 수 있다 */
export function validateMetricInput(raw: unknown): MetricInput {
  if (!isObj(raw)) fail('INPUT_INVALID');
  const m = raw as Record<string, unknown>;
  if (!oneOf(MODELS, m.model)) fail('MODEL_INVALID');
  if (!isObj(m.period) || !isCalendarDate(m.period.from) || !isCalendarDate(m.period.to)) fail('PERIOD_INVALID');
  const period = m.period as { from: string; to: string };
  if (period.from > period.to) fail('PERIOD_INVALID');
  if (m.model === 'cohort') {
    if (!(typeof m.windowDays === 'number' && Number.isSafeInteger(m.windowDays) && m.windowDays >= 1 && m.windowDays <= MAX_WINDOW_DAYS)) fail('WINDOW_INVALID');
  } else if (m.windowDays !== null) fail('WINDOW_INVALID');
  if (typeof m.source !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(m.source)) fail('SOURCE_INVALID');
  if (!oneOf(TRAFFIC_KINDS, m.traffic)) fail('TRAFFIC_INVALID');
  if (!(m.format === null || oneOf(AD_FORMATS, m.format))) fail('FORMAT_INVALID');
  if (!(m.spendIncludesVat === null || typeof m.spendIncludesVat === 'boolean')) fail('VAT_FLAG_INVALID');
  for (const k of ['impressions', 'clicks', 'visits'] as const) if (!isCountOrNull(m[k])) fail('COUNT_INVALID');
  if (!(m.spendKrw === null || (isCount(m.spendKrw) && (m.spendKrw as number) <= MAX_AMOUNT_KRW))) fail('AMOUNT_INVALID');
  if (!(m.recognizedRevenueKrw === null || (typeof m.recognizedRevenueKrw === 'number' && Number.isSafeInteger(m.recognizedRevenueKrw) && Math.abs(m.recognizedRevenueKrw) <= MAX_AMOUNT_KRW)))
    fail('AMOUNT_INVALID');
  if (!isObj(m.conversions)) fail('CONVERSIONS_INVALID');
  const conv = m.conversions as Record<string, unknown>;
  for (const [k, v] of Object.entries(conv)) {
    if (!oneOf(CONVERSION_STAGES, k)) fail('CONVERSION_STAGE_INVALID');
    if (!isCountOrNull(v)) fail('COUNT_INVALID');
  }
  const clicks = m.clicks as number | null, impressions = m.impressions as number | null;
  if (clicks !== null && impressions !== null && clicks > impressions) fail('CLICKS_EXCEED_IMPRESSIONS');
  if (m.traffic !== 'paid' && m.spendKrw !== null && m.spendKrw !== 0) fail('SPEND_ON_NON_PAID');
  if (m.model === 'cohort') {
    // 같은 유입 코호트의 단계별 수: 뒤 단계가 앞 단계보다 클 수 없다(모르는 단계는 건너뛰고 아는 값끼리 비교)
    let prev: number | null = null;
    for (const s of CONVERSION_STAGES) {
      const v = conv[s];
      if (typeof v !== 'number') continue;
      if (prev !== null && v > prev) fail('STAGE_ORDER_INVALID');
      prev = v;
    }
  } else if (m.recognizedRevenueKrw !== null) {
    fail('REVENUE_REQUIRES_COHORT'); // 귀속 없는 기간 매출로 ROAS를 만들지 않는다
  }
  return m as unknown as MetricInput;
}

const div = (a: number | null | undefined, b: number | null | undefined) =>
  typeof a === 'number' && typeof b === 'number' && b > 0 ? a / b : null;
const round = (x: number | null, d: number) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const pct = (x: number | null) => (x === null ? null : x * 100);

export function computeMetrics(raw: unknown, cvrDenominator: 'clicks' | 'visits' = 'clicks'): Metrics {
  if (cvrDenominator !== 'clicks' && cvrDenominator !== 'visits') fail('DENOMINATOR_INVALID');
  const m = validateMetricInput(raw);
  const spend = m.traffic === 'paid' ? m.spendKrw : null;
  const denom = cvrDenominator === 'clicks' ? m.clicks : m.visits;
  const cpa: Metrics['cpa'] = {};
  const cvr: Metrics['cvr'] = {};
  for (const s of CONVERSION_STAGES) {
    if (!(s in m.conversions)) continue;
    const n = m.conversions[s] ?? null;
    cpa[s] = round(div(spend, n), 0);
    cvr[s] = round(pct(div(n, denom)), 2);
  }
  const roas = m.model === 'cohort' && m.recognizedRevenueKrw !== null && typeof spend === 'number' && spend > 0
    ? round((m.recognizedRevenueKrw / spend) * 100, 1) : null;
  return {
    model: m.model,
    cpm: round(div(spend, m.impressions) === null ? null : div(spend, m.impressions)! * 1000, 0),
    cpc: round(div(spend, m.clicks), 0),
    ctr: round(pct(div(m.clicks, m.impressions)), 2),
    cpa, cvr, cvrDenominator, roas, cpi: 'not_applicable',
  };
}
