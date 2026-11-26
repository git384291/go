/**
 * googleAdsCpc 테스트 — 오프라인
 */
import {
  calculateCpcAdjustments,
  applyCpcAdjustments,
  formatAdjustmentReport,
  MONTHLY_BUDGET_CAP_MICROS,
  MAX_CPC_MICROS,
  MIN_CPC_MICROS,
  MIN_CLICKS_FOR_ADJUST,
  TARGET_CPA_MICROS,
  type KeywordPerformance,
} from './googleAdsCpc';

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean) {
  if (cond) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}`); failed++; }
}

const baseKw: KeywordPerformance = {
  keywordId: 'kw1',
  keywordText: '인천 인터넷 가입',
  impressions: 1000,
  clicks: 50,
  conversions: 5,
  costMicros: 25_000_000,
  currentCpcMicros: 500_000,
};

// ── 1. 클릭 부족 → 스킵
{
  const kw = { ...baseKw, clicks: MIN_CLICKS_FOR_ADJUST - 1 };
  const r = calculateCpcAdjustments([kw], 0);
  assert('클릭 부족 → 스킵', r.adjustments.length === 0 && r.skipped.length === 1);
}

// ── 2. CPA 목표 이하 → CPC 상향
{
  // CPA = 25,000,000 / 5 = 5,000,000 micros(5,000원) < TARGET_CPA(10,000원) → 상향
  const r = calculateCpcAdjustments([baseKw], 0);
  assert('CPA 목표 이하 → CPC 상향', r.adjustments.length === 1 && r.adjustments[0].newCpcMicros > baseKw.currentCpcMicros);
  assert('CPC 최대 한도 미초과', r.adjustments[0].newCpcMicros <= MAX_CPC_MICROS);
}

// ── 3. CTR 저조·전환 없음 → CPC 하향
{
  const kw: KeywordPerformance = { ...baseKw, impressions: 10000, clicks: 20, conversions: 0, costMicros: 10_000_000 };
  const r = calculateCpcAdjustments([kw], 0);
  assert('CTR 저조 → CPC 하향', r.adjustments.length === 1 && r.adjustments[0].newCpcMicros < kw.currentCpcMicros);
  assert('CPC 최소 한도 미달 없음', r.adjustments[0].newCpcMicros >= MIN_CPC_MICROS);
}

// ── 4. CPA 과다 → CPC 하향
{
  const kw: KeywordPerformance = { ...baseKw, conversions: 1, costMicros: 20_000_000 }; // CPA 20,000원
  const r = calculateCpcAdjustments([kw], 0);
  assert('CPA 과다 → CPC 하향', r.adjustments.length === 1 && r.adjustments[0].newCpcMicros < kw.currentCpcMicros);
}

// ── 5. 월 예산 90% 도달 시 CPC 상향 차단
{
  const r = calculateCpcAdjustments([baseKw], MONTHLY_BUDGET_CAP_MICROS * 0.95);
  const hasUpward = r.adjustments.some(a => a.newCpcMicros > a.currentCpcMicros);
  assert('예산 90% → CPC 상향 차단', !hasUpward);
}

// ── 6. 한도 클램핑
{
  const kw: KeywordPerformance = { ...baseKw, currentCpcMicros: MAX_CPC_MICROS };
  const r = calculateCpcAdjustments([kw], 0);
  if (r.adjustments.length > 0) {
    assert('MAX_CPC 클램핑', r.adjustments[0].newCpcMicros <= MAX_CPC_MICROS);
  } else {
    assert('MAX_CPC 도달 시 변화 없어 스킵', r.skipped.length > 0);
  }
}

// ── 7. 노출 없음 → 스킵
{
  const kw = { ...baseKw, impressions: 0 };
  const r = calculateCpcAdjustments([kw], 0);
  assert('노출 없음 → 스킵', r.adjustments.length === 0);
}

// ── 8. PUBLISH_ENABLED=false 차단
{
  const adj = [{ keywordId: 'kw1', keywordText: '테스트', currentCpcMicros: 500_000, newCpcMicros: 600_000, reason: '테스트', changePercent: 20 }];
  applyCpcAdjustments(adj, '123456789', false).then(r => {
    assert('PUBLISH_ENABLED=false → 적용 없음', r.applied.length === 0);
    assert('PUBLISH_ENABLED=false → 실패 메시지', r.failed[0].error.includes('승인'));

    // ── 9. 보고서 생성
    const report = formatAdjustmentReport({
      adjustments: adj,
      skipped: [{ keywordId: 'kw2', reason: '클릭 부족' }],
      totalBudgetImpactMicros: 100_000,
    });
    assert('보고서 생성 성공', report.includes('CPC 자동 조정 보고'));
    assert('보고서에 키워드 포함', report.includes('테스트'));

    console.log(`\n${'─'.repeat(50)}`);
    if (failed === 0) console.log(`\n🎉 모든 테스트 통과 (${passed}/${passed + failed})`);
    else { console.log(`\n⚠️  ${failed}개 실패 / ${passed}개 통과`); process.exit(1); }
  });
}
