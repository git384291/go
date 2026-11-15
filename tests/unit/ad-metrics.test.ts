// 광고 지표 계산: 가상 표본만 사용(실제 광고·실적 아님)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, MetricInputError, sanitizeUtm, type MetricInput } from '../../src/content/adMetrics';

const base: MetricInput = {
  period: { from: '2026-11-17', to: '2026-11-23' }, source: 'sample', traffic: 'paid', format: 'search',
  spendKrw: 100_000, spendIncludesVat: false, impressions: 20_000, clicks: 400, visits: 380,
  conversions: { consult_request: 20, signup: 8, activation: 5 }, recognizedRevenueKrw: null, revenueAttributionDays: null,
};

test('A1 공식: CPM·CPC·CTR·CPA·CVR(클릭 분모)', () => {
  const r = computeMetrics(base);
  assert.equal(r.cpm, 5000);         // 100000/20000*1000
  assert.equal(r.cpc, 250);          // 100000/400
  assert.equal(r.ctr, 2);            // 400/20000*100
  assert.deepEqual(r.cpa, { consult_request: 5000, signup: 12500, activation: 20000 });
  assert.deepEqual(r.cvr, { consult_request: 5, signup: 2, activation: 1.25 });
  assert.equal(r.cvrDenominator, 'clicks');
  assert.equal(r.cpi, 'not_applicable');
});

test('A2 CVR 분모를 방문으로 명시하면 방문 기준', () => {
  assert.equal(computeMetrics(base, 'visits').cvr.consult_request, 5.26); // 20/380*100
});

test('A3 분모 0·미수집은 0%가 아니라 null', () => {
  const r = computeMetrics({ ...base, impressions: null, clicks: 0, visits: null, conversions: { consult_request: 0, signup: null } });
  assert.equal(r.cpm, null); assert.equal(r.cpc, null); assert.equal(r.ctr, null);
  assert.equal(r.cpa.consult_request, null); assert.equal(r.cpa.signup, null);
  assert.equal(r.cvr.consult_request, null);
  assert.equal(computeMetrics(base, 'visits').cvr.consult_request !== null, true);
  assert.equal(computeMetrics({ ...base, visits: null }, 'visits').cvr.consult_request, null);
});

test('A4 ROAS: 인정된 수수료 매출만, 미확인이면 null, 환수로 음수 가능, 귀속 기간 필수', () => {
  assert.equal(computeMetrics(base).roas, null);
  assert.equal(computeMetrics({ ...base, recognizedRevenueKrw: 150_000, revenueAttributionDays: 30 }).roas, 150);
  assert.equal(computeMetrics({ ...base, recognizedRevenueKrw: -20_000, revenueAttributionDays: 30 }).roas, -20);
  assert.throws(() => computeMetrics({ ...base, recognizedRevenueKrw: 150_000 }), MetricInputError);
});

test('A5 자연 검색: 비용 지표·ROAS 없음, 비용이 있으면 거부(유료와 섞지 않음)', () => {
  const r = computeMetrics({ ...base, traffic: 'organic', format: null, spendKrw: null, recognizedRevenueKrw: 50_000, revenueAttributionDays: 30 });
  assert.equal(r.cpc, null); assert.equal(r.cpm, null); assert.equal(r.roas, null); assert.equal(r.cpa.consult_request, null);
  assert.equal(r.ctr, 2);
  assert.throws(() => computeMetrics({ ...base, traffic: 'organic', spendKrw: 1000 }), /SPEND_ON_NON_PAID/);
});

test('A6 잘못된 입력은 계산하지 않음', () => {
  const bad: [Partial<MetricInput>, string][] = [
    [{ clicks: 30_000 }, 'CLICKS_EXCEED_IMPRESSIONS'],
    [{ clicks: -1 }, 'COUNT_INVALID'],
    [{ impressions: 1.5 }, 'COUNT_INVALID'],
    [{ spendKrw: -1 }, 'AMOUNT_INVALID'],
    [{ spendKrw: 10.5 }, 'AMOUNT_INVALID'],
    [{ conversions: { consult_request: 2, signup: 5 } }, 'STAGE_ORDER_INVALID'],
    [{ period: { from: '2026-11-23', to: '2026-11-17' } }, 'PERIOD_INVALID'],
  ];
  for (const [patch, code] of bad) assert.throws(() => computeMetrics({ ...base, ...patch }), (e: Error) => e instanceof MetricInputError && e.message === code, code);
});

test('A7 UTM: 허용 키·형식만, 개인정보처럼 보이는 값과 다른 키는 버림', () => {
  assert.deepEqual(sanitizeUtm({ utm_source: 'Naver', utm_medium: 'cpc', utm_campaign: 'move_2026-11', utm_content: 'ad_a', gclid: 'x', phone: '01012345678' }),
    { utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'move_2026-11', utm_content: 'ad_a' });
  for (const v of ['010-1234-5678', '01012345678', 'a@b.com', '900101-1234567', '홍길동', '서울시', 'x'.repeat(65), 'a b', '<script>']) {
    assert.deepEqual(sanitizeUtm({ utm_campaign: v }), {}, v);
  }
});
