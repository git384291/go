// 광고 지표 계산·입력 검증·UTM 허용 목록: 가상 표본만 사용(실제 광고·실적 아님)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, isCalendarDate, MetricInputError, MAX_AMOUNT_KRW, type MetricInput } from '../../src/content/adMetrics';
import { matchUtm, UTM_REGISTRY, UtmRegistryError, validateRegistry, MAX_REGISTRY_SIZE } from '../../src/content/utm';

const base: MetricInput = {
  model: 'cohort', period: { from: '2026-11-17', to: '2026-11-23' }, windowDays: 30,
  source: 'sample', traffic: 'paid', format: 'search',
  spendKrw: 100_000, spendIncludesVat: false, impressions: 20_000, clicks: 400, visits: 380,
  conversions: { consult_request: 20, signup: 8, activation: 5 }, recognizedRevenueKrw: null,
};
const code = (fn: () => unknown, c: string) => assert.throws(fn, (e: Error) => e instanceof MetricInputError && e.message === c, c);

test('A1 공식: CPM·CPC·CTR·CPA·CVR(클릭 분모)', () => {
  const r = computeMetrics(base);
  assert.equal(r.cpm, 5000); assert.equal(r.cpc, 250); assert.equal(r.ctr, 2);
  assert.deepEqual(r.cpa, { consult_request: 5000, signup: 12500, activation: 20000 });
  assert.deepEqual(r.cvr, { consult_request: 5, signup: 2, activation: 1.25 });
  assert.equal(r.cpi, 'not_applicable'); assert.equal(r.model, 'cohort');
});

test('A2 CVR 분모 방문 명시, 잘못된 분모 이름 거부', () => {
  assert.equal(computeMetrics(base, 'visits').cvr.consult_request, 5.26);
  code(() => computeMetrics(base, 'sessions' as 'clicks'), 'DENOMINATOR_INVALID');
});

test('A3 분모 0·미수집은 null', () => {
  const r = computeMetrics({ ...base, impressions: null, clicks: 0, visits: null, conversions: { consult_request: 0, signup: null } });
  assert.equal(r.cpm, null); assert.equal(r.cpc, null); assert.equal(r.ctr, null);
  assert.equal(r.cpa.consult_request, null); assert.equal(r.cpa.signup, null); assert.equal(r.cvr.consult_request, null);
  assert.equal(computeMetrics({ ...base, visits: null }, 'visits').cvr.consult_request, null);
});

test('A4 ROAS는 코호트 모델에서만: 인정 매출, 환수 음수 가능, 매출 미확인 null', () => {
  assert.equal(computeMetrics(base).roas, null);
  assert.equal(computeMetrics({ ...base, recognizedRevenueKrw: 150_000 }).roas, 150);
  assert.equal(computeMetrics({ ...base, recognizedRevenueKrw: -20_000 }).roas, -20);
});

test('A5 발생 집계(occurrence): 단계 역전 허용(지난달 접수의 이번달 개통), 귀속 창 없음, 매출 넣으면 거부, ROAS null', () => {
  const occ: MetricInput = { ...base, model: 'occurrence', windowDays: null, conversions: { consult_request: 3, signup: 5, activation: 7 } };
  const r = computeMetrics(occ);
  assert.equal(r.model, 'occurrence'); assert.equal(r.roas, null);
  assert.deepEqual(r.cpa, { consult_request: 33333, signup: 20000, activation: 14286 });
  code(() => computeMetrics({ ...occ, windowDays: 30 }), 'WINDOW_INVALID');
  code(() => computeMetrics({ ...occ, recognizedRevenueKrw: 100_000 }), 'REVENUE_REQUIRES_COHORT');
  // 같은 입력을 코호트로 넣으면 단계 역전으로 거부
  code(() => computeMetrics({ ...occ, model: 'cohort', windowDays: 30 }), 'STAGE_ORDER_INVALID');
  // 코호트에서 모르는 단계는 건너뛰고 아는 값끼리 비교
  code(() => computeMetrics({ ...base, conversions: { consult_request: 2, signup: null, activation: 5 } }), 'STAGE_ORDER_INVALID');
});

test('A6 날짜: 달력상 유효한 날짜·윤년만', () => {
  for (const ok of ['2028-02-29', '2026-12-31', '2026-01-01']) assert.equal(isCalendarDate(ok), true, ok);
  for (const bad of ['2026-02-31', '2026-02-29', '2100-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '26-11-17', '2026-11-17T00:00', '', null, 20261117, '1999-12-31'])
    assert.equal(isCalendarDate(bad), false, String(bad));
  code(() => computeMetrics({ ...base, period: { from: '2026-02-31', to: '2026-03-01' } }), 'PERIOD_INVALID');
  code(() => computeMetrics({ ...base, period: { from: '2026-11-23', to: '2026-11-17' } }), 'PERIOD_INVALID');
});

test('A7 PM 재현값 거부: 2026-02-31 기간 + 귀속 -1일로 ROAS 산출되던 입력', () => {
  code(() => computeMetrics({ ...base, period: { from: '2026-02-31', to: '2026-02-31' }, windowDays: -1, recognizedRevenueKrw: 1_000_000 }), 'PERIOD_INVALID');
  for (const w of [-1, 0, 1.5, 366, Number.NaN, Infinity, '30', null]) {
    code(() => computeMetrics({ ...base, windowDays: w as number }), 'WINDOW_INVALID');
  }
  assert.equal(computeMetrics({ ...base, windowDays: 1 }).model, 'cohort');
  assert.equal(computeMetrics({ ...base, windowDays: 365 }).model, 'cohort');
});

test('A8 실행 시점 enum·전환 키·누락 필드 거부(타입 선언 무시한 입력)', () => {
  const bad: [Record<string, unknown>, string][] = [
    [{ model: 'daily' }, 'MODEL_INVALID'], [{ model: undefined }, 'MODEL_INVALID'],
    [{ traffic: 'ads' }, 'TRAFFIC_INVALID'], [{ format: 'video' }, 'FORMAT_INVALID'],
    [{ source: 'Naver' }, 'SOURCE_INVALID'], [{ source: '' }, 'SOURCE_INVALID'],
    [{ spendIncludesVat: 'yes' }, 'VAT_FLAG_INVALID'],
    [{ conversions: { purchase: 1 } }, 'CONVERSION_STAGE_INVALID'], [{ conversions: JSON.parse('{"__proto__":1}') }, 'CONVERSION_STAGE_INVALID'], [{ conversions: { constructor: 1 } }, 'CONVERSION_STAGE_INVALID'],
    [{ conversions: null }, 'CONVERSIONS_INVALID'], [{ period: null }, 'PERIOD_INVALID'],
  ];
  for (const [patch, c] of bad) code(() => computeMetrics({ ...base, ...patch }), c);
  code(() => computeMetrics(null), 'INPUT_INVALID');
  code(() => computeMetrics([base]), 'INPUT_INVALID');
});

test('A9 안전한 정수 범위: 횟수·금액', () => {
  for (const v of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, '100']) {
    code(() => computeMetrics({ ...base, impressions: v as number }), 'COUNT_INVALID');
    code(() => computeMetrics({ ...base, conversions: { consult_request: v as number } }), 'COUNT_INVALID');
  }
  for (const v of [-1, 10.5, MAX_AMOUNT_KRW + 1, Number.NaN, '1000']) code(() => computeMetrics({ ...base, spendKrw: v as number }), 'AMOUNT_INVALID');
  for (const v of [MAX_AMOUNT_KRW + 1, -(MAX_AMOUNT_KRW + 1), 0.5]) code(() => computeMetrics({ ...base, recognizedRevenueKrw: v }), 'AMOUNT_INVALID');
  assert.equal(computeMetrics({ ...base, spendKrw: MAX_AMOUNT_KRW, impressions: Number.MAX_SAFE_INTEGER, clicks: 1 }).cpc, MAX_AMOUNT_KRW);
  code(() => computeMetrics({ ...base, clicks: 30_000 }), 'CLICKS_EXCEED_IMPRESSIONS');
  code(() => computeMetrics({ ...base, traffic: 'organic', spendKrw: 1000 }), 'SPEND_ON_NON_PAID');
  const org = computeMetrics({ ...base, traffic: 'organic', format: null, spendKrw: null });
  assert.equal(org.cpc, null); assert.equal(org.roas, null);
});

const REG = validateRegistry([
  { source: 'naver', medium: 'cpc', campaign: 'move-2611', content: 'ad-a' },
  { source: 'naver', medium: 'cpc', campaign: 'move-2611', content: 'ad-b' },
  { source: 'meta', medium: 'paid-social', campaign: 'contract-end-2611' },
]);

test('U1 UTM: 등록된 조합과 정확히 일치할 때만 통과, 미등록·부분 일치·대소문자 다름은 전부 버림', () => {
  assert.deepEqual(matchUtm({ utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'move-2611', utm_content: 'ad-a', gclid: 'x' }, REG),
    { utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'move-2611', utm_content: 'ad-a' });
  assert.deepEqual(matchUtm({ utm_source: 'meta', utm_medium: 'paid-social', utm_campaign: 'contract-end-2611' }, REG),
    { utm_source: 'meta', utm_medium: 'paid-social', utm_campaign: 'contract-end-2611' });
  for (const p of [
    { utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'john.smith' }, // PM 재현값: 형식상 정상이지만 미등록
    { utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'move-2611', utm_content: 'john' },
    { utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'move-2611' }, // content 필수 조합에서 누락
    { utm_source: 'Naver', utm_medium: 'cpc', utm_campaign: 'move-2611', utm_content: 'ad-a' },
    { utm_source: 'meta', utm_medium: 'paid-social', utm_campaign: 'contract-end-2611', utm_content: 'x' },
    { utm_campaign: 'move-2611' }, {},
  ]) assert.deepEqual(matchUtm(p, REG), {}, JSON.stringify(p));
});

test('U2 현재 등록부는 비어 있음(광고 미집행) → 어떤 값도 통과하지 않음', () => {
  assert.equal(UTM_REGISTRY.length, 0);
  assert.deepEqual(matchUtm({ utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'move-2611' }), {});
});

test('U3 등록부 검증: 형식·중복·추가 필드·개수 상한', () => {
  for (const bad of [
    [{ source: 'Naver', medium: 'cpc', campaign: 'x' }], [{ source: 'a', medium: 'b', campaign: 'c.d' }],
    [{ source: 'a', medium: 'b', campaign: 'c', phone: '010' }], [{ source: 'a', medium: 'b', campaign: 'c' }, { source: 'a', medium: 'b', campaign: 'c' }],
    Array.from({ length: MAX_REGISTRY_SIZE + 1 }, (_, i) => ({ source: 'a', medium: 'b', campaign: `c${i}` })), 'x',
  ]) assert.throws(() => validateRegistry(bad), UtmRegistryError);
});
