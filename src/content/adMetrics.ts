/**
 * 광고 지표 순수 계산(PHASE 1: 계산·검증만). 수집·추적·외부 전송·DB 저장 없음.
 * 원칙
 * - 금액은 원 단위 정수. 기간·출처·세금 포함 여부·귀속 기간·전환 단계를 함께 기록한다.
 * - 분모 0, 미수집, 연동 안 됨은 0%가 아니라 null(미확인).
 * - 매출은 실제 인정된 판매 수수료(환수·취소 차감)만. 통신사 월요금·고객 계약액·개당 예상 마진으로 ROAS를 만들지 않는다.
 * - 자연 검색과 유료 광고를 섞지 않는다. CPI는 앱 설치 캠페인이 없어 해당 없음.
 */
export type ConversionStage = 'consult_request' | 'signup' | 'activation' | 'settlement';
export type TrafficKind = 'paid' | 'organic' | 'direct' | 'referral';
export type AdFormat = 'search' | 'display' | 'social' | 'other'; // SA=search, DA=display

/** 집계 1건. 모르는 값은 null(0으로 채우지 않음) */
export type MetricInput = {
  period: { from: string; to: string }; // YYYY-MM-DD, Asia/Seoul
  source: string; // utm_source 등 비식별 값
  traffic: TrafficKind;
  format: AdFormat | null;
  spendKrw: number | null;
  spendIncludesVat: boolean | null;
  impressions: number | null;
  clicks: number | null;
  visits: number | null;
  conversions: Partial<Record<ConversionStage, number | null>>;
  /** 실제 인정된 판매 수수료(원), 환수·취소 차감 후. 귀속 기간과 함께 */
  recognizedRevenueKrw: number | null;
  revenueAttributionDays: number | null;
};

export type Metrics = {
  cpm: number | null; cpc: number | null; ctr: number | null;
  cpa: Partial<Record<ConversionStage, number | null>>;
  cvr: Partial<Record<ConversionStage, number | null>>;
  cvrDenominator: 'clicks' | 'visits';
  roas: number | null;
  cpi: 'not_applicable';
};

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const div = (a: number | null | undefined, b: number | null | undefined) => (known(a) && known(b) && b > 0 ? a / b : null);
const round = (x: number | null, d: number) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export class MetricInputError extends Error {}

/** 입력 검증: 음수·비정수 횟수·클릭>노출·전환 단계 역전 등은 계산하지 않고 거부 */
export function validateMetricInput(m: MetricInput): void {
  const counts = [m.impressions, m.clicks, m.visits, ...Object.values(m.conversions)];
  for (const c of counts) if (c !== null && c !== undefined && (!Number.isInteger(c) || c < 0)) throw new MetricInputError('COUNT_INVALID');
  if (m.spendKrw !== null && (!Number.isInteger(m.spendKrw) || m.spendKrw < 0)) throw new MetricInputError('AMOUNT_INVALID');
  // 매출은 환수·취소 차감 결과라 음수일 수 있다(정수만)
  if (m.recognizedRevenueKrw !== null && !Number.isInteger(m.recognizedRevenueKrw)) throw new MetricInputError('AMOUNT_INVALID');
  if (known(m.clicks) && known(m.impressions) && m.clicks > m.impressions) throw new MetricInputError('CLICKS_EXCEED_IMPRESSIONS');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(m.period.to) || m.period.from > m.period.to) throw new MetricInputError('PERIOD_INVALID');
  if (m.traffic !== 'paid' && (m.spendKrw ?? 0) !== 0) throw new MetricInputError('SPEND_ON_NON_PAID');
  const order: ConversionStage[] = ['consult_request', 'signup', 'activation', 'settlement'];
  for (let i = 1; i < order.length; i++) {
    const a = m.conversions[order[i - 1]], b = m.conversions[order[i]];
    if (known(a) && known(b) && b > a) throw new MetricInputError('STAGE_ORDER_INVALID');
  }
  if (m.recognizedRevenueKrw !== null && m.revenueAttributionDays === null) throw new MetricInputError('ATTRIBUTION_MISSING');
}

export function computeMetrics(m: MetricInput, cvrDenominator: 'clicks' | 'visits' = 'clicks'): Metrics {
  validateMetricInput(m);
  const paid = m.traffic === 'paid';
  const spend = paid ? m.spendKrw : null;
  const denom = cvrDenominator === 'clicks' ? m.clicks : m.visits;
  const cpa: Metrics['cpa'] = {};
  const cvr: Metrics['cvr'] = {};
  for (const [stage, n] of Object.entries(m.conversions) as [ConversionStage, number | null][]) {
    cpa[stage] = round(div(spend, n), 0);
    cvr[stage] = round(div(n, denom) === null ? null : div(n, denom)! * 100, 2);
  }
  return {
    cpm: round(div(spend, m.impressions) === null ? null : div(spend, m.impressions)! * 1000, 0),
    cpc: round(div(spend, m.clicks), 0),
    ctr: round(div(m.clicks, m.impressions) === null ? null : div(m.clicks, m.impressions)! * 100, 2),
    cpa,
    cvr,
    cvrDenominator,
    roas: paid && m.recognizedRevenueKrw !== null && known(spend) && spend > 0 ? round((m.recognizedRevenueKrw / spend) * 100, 1) : null,
    cpi: 'not_applicable',
  };
}

/** UTM: 허용 키·형식만 통과. 전화·메일·이름·주민번호·주소처럼 보이는 값은 버린다 */
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const;
export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;
const SAFE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PII_LIKE = /(@|\d{2,3}-?\d{3,4}-?\d{4}|\d{6}-?\d{7}|[가-힣])/;

export function sanitizeUtm(params: Record<string, unknown>): Utm {
  const out: Utm = {};
  for (const k of UTM_KEYS) {
    const v = params[k];
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (SAFE.test(s) && !PII_LIKE.test(s)) out[k] = s;
  }
  return out;
}
