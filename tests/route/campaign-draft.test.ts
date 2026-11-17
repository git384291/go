// 광고 캠페인 초안(PM 6943038907) — react-server 조건(server-only). 가상 입력만. 집행 기능 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampaignDraft, CAMPAIGN_BLOCKERS, AD_DAILY_CAP_KRW, AD_FIRST3DAYS_CAP_KRW } from '../../src/server/advertising/campaignDraft';

const ok = { draftId: 'moving', product: 'internet-tv', dailyBudgetKrw: 9000, totalBudgetKrw: 27000 };
const INVALID = { ok: false, error: 'INVALID_INPUT' };

test('CD1 정상 범위여도 미게시 초안·executionAllowed false·blocker 전부 유지', () => {
  for (const draftId of ['moving', 'contract_end', 'general_compare']) {
    for (const [d, t] of [[1, 1], [9000, 27000], [AD_DAILY_CAP_KRW, AD_FIRST3DAYS_CAP_KRW], [5000, 5000]]) {
      const r = buildCampaignDraft({ ...ok, draftId, dailyBudgetKrw: d, totalBudgetKrw: t });
      assert.equal(r.ok, true, `${draftId} ${d}/${t}`);
      if (r.ok) {
        assert.equal(r.draft.status, 'DRAFT_UNPUBLISHED');
        assert.equal(r.draft.executionAllowed, false);
        assert.deepEqual([...r.draft.blockers], [...CAMPAIGN_BLOCKERS]);
        assert.ok(r.draft.blockers.includes('CAP_NOT_VERIFIED'));
        assert.equal(r.draft.budget.capEnforcement, 'NOT_VERIFIED');
        assert.equal(r.draft.budget.taxAndFeesIncluded, true);
        assert.equal(r.draft.destination, 'UNSET');
        assert.equal(r.draft.cta, 'UNSET');
        assert.ok(r.draft.titleLength <= 15 && r.draft.descriptionLength >= 20 && r.draft.descriptionLength <= 45);
      }
    }
  }
});

test('CD2 형식 거부: unknown ID·null·배열·추가 키·예약 상품·자유 문구', () => {
  const bad: unknown[] = [
    undefined, null, 0, 'moving', [], [ok], {}, new Map(Object.entries(ok)), new (class X { draftId = 'moving'; product = 'internet-tv'; dailyBudgetKrw = 1; totalBudgetKrw = 1; })(),
    { ...ok, draftId: 'unknown' }, { ...ok, draftId: 'MOVING' }, { ...ok, draftId: '__proto__' }, { ...ok, draftId: null },
    { ...ok, product: 'internet-phone' }, { ...ok, product: 'cctv-security' }, { ...ok, product: 'internet_tv' },
    { ...ok, title: '최저가 보장' }, { ...ok, url: 'https://evil.example.net/' }, { ...ok, phone: '01012345678' }, { ...ok, approved: true }, { ...ok, reviewRef: 'PM-000000' },
    { draftId: 'moving', product: 'internet-tv', dailyBudgetKrw: 9000 },
  ];
  for (const b of bad) assert.deepEqual(buildCampaignDraft(b), INVALID, JSON.stringify(b) ?? String(b));
  const throwing = { draftId: 'moving', product: 'internet-tv', dailyBudgetKrw: 1, get totalBudgetKrw(): number { throw new Error('secret-detail'); } };
  const r = buildCampaignDraft(throwing);
  assert.deepEqual(r, INVALID);
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('CD3 예산 거부: 음수·0·소수·NaN·Infinity·문자열·초과·총액 관계 위반', () => {
  const daily = [-1, 0, 0.5, 9000.1, NaN, Infinity, -Infinity, '9000', 10001, 2 ** 53, null];
  for (const v of daily) assert.deepEqual(buildCampaignDraft({ ...ok, dailyBudgetKrw: v }), INVALID, `daily ${String(v)}`);
  const total = [-1, 0, 1.5, NaN, Infinity, '27000', 30001, 1e9];
  for (const v of total) assert.deepEqual(buildCampaignDraft({ ...ok, totalBudgetKrw: v }), INVALID, `total ${String(v)}`);
  assert.deepEqual(buildCampaignDraft({ ...ok, dailyBudgetKrw: 9000, totalBudgetKrw: 8999 }), INVALID, '총액 < 일');
  assert.deepEqual(buildCampaignDraft({ ...ok, dailyBudgetKrw: 5000, totalBudgetKrw: 15001 }), INVALID, '총액 > 일×3');
});

test('CD4 허용 목록 DTO·원본 불변·동결·민감 표식 비반환', () => {
  const input = { ...ok };
  const before = JSON.stringify(input);
  const r = buildCampaignDraft(input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(Object.keys(r.draft).sort(), ['blockers', 'budget', 'cta', 'description', 'descriptionLength', 'destination', 'draftId', 'executionAllowed', 'product', 'situation', 'status', 'title', 'titleLength']);
    assert.deepEqual(Object.keys(r.draft.budget).sort(), ['capEnforcement', 'dailyCapKrw', 'dailyKrw', 'first3DaysCapKrw', 'taxAndFeesIncluded', 'totalKrw']);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.draft) && Object.isFrozen(r.draft.budget) && Object.isFrozen(r.draft.blockers));
    assert.throws(() => { (r.draft as unknown as { executionAllowed: boolean }).executionAllowed = true; });
    assert.throws(() => { (r.draft.blockers as unknown as string[]).length = 0; });
    assert.throws(() => { (CAMPAIGN_BLOCKERS as unknown as string[]).pop(); });
    assert.ok(!/https?:|@|010|PM-|token|secret/i.test(JSON.stringify(r)));
  }
  assert.deepEqual(buildCampaignDraft(ok), r, '같은 입력 → 같은 출력');
});
