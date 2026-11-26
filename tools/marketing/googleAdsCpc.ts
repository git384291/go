/**
 * 바른365 — (앱 밖 도구, 미연결) Google Ads 성과 기반 CPC 자동 조정 모듈
 * 보안: PUBLISH_ENABLED=false 기본 — 사용자 승인 전 실제 CPC 변경 금지
 * 광고비 한도 초과·ENABLED 자동전환·과금 금지
 * Google Ads API Basic 승인 완료 후에만 실계정 사용 가능
 */

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export interface KeywordPerformance {
  keywordId: string;
  keywordText: string;
  impressions: number;
  clicks: number;
  conversions: number;
  costMicros: number;      // 1,000,000 = 1원
  currentCpcMicros: number;
}

export interface CpcAdjustment {
  keywordId: string;
  keywordText: string;
  currentCpcMicros: number;
  newCpcMicros: number;
  reason: string;
  changePercent: number;
}

export interface AdjustmentResult {
  adjustments: CpcAdjustment[];
  skipped: { keywordId: string; reason: string }[];
  totalBudgetImpactMicros: number;
}

// ─── 상수 ─────────────────────────────────────────────────────────────────────

// 광고비 한도 (월 50만 원 = 500,000,000 micros)
export const MONTHLY_BUDGET_CAP_MICROS = 500_000_000;

// CPC 한도
export const MAX_CPC_MICROS = 2_000_000;   // 2,000원
export const MIN_CPC_MICROS = 100_000;     // 100원

// 조정 한도 (1회 최대 ±20%)
export const MAX_ADJUST_RATIO = 0.20;

// 목표 전환당 비용 (10,000원 = 10,000,000 micros)
export const TARGET_CPA_MICROS = 10_000_000;

// 최소 클릭 수 (통계적 신뢰도)
export const MIN_CLICKS_FOR_ADJUST = 10;

// ─── CPC 조정 로직 ────────────────────────────────────────────────────────────

/**
 * 성과 기반 CPC 조정값 계산.
 * 실제 API 호출 없이 순수 계산만 수행.
 */
export function calculateCpcAdjustments(
  keywords: KeywordPerformance[],
  spentThisMonthMicros: number,
): AdjustmentResult {
  const adjustments: CpcAdjustment[] = [];
  const skipped: { keywordId: string; reason: string }[] = [];

  for (const kw of keywords) {
    // 1. 최소 클릭 수 미달 → 스킵
    if (kw.clicks < MIN_CLICKS_FOR_ADJUST) {
      skipped.push({ keywordId: kw.keywordId, reason: `클릭 수 부족 (${kw.clicks}/${MIN_CLICKS_FOR_ADJUST})` });
      continue;
    }

    // 2. 노출 없음 → 스킵
    if (kw.impressions === 0) {
      skipped.push({ keywordId: kw.keywordId, reason: '노출 없음' });
      continue;
    }

    const ctr = kw.clicks / kw.impressions;
    const cpa = kw.conversions > 0 ? kw.costMicros / kw.conversions : Infinity;
    let newCpc = kw.currentCpcMicros;
    let reason = '';

    // 3. 전환 있고 CPA가 목표 이하 → CPC 올림 (최대 +20%)
    if (kw.conversions > 0 && cpa <= TARGET_CPA_MICROS) {
      const boost = Math.min(MAX_ADJUST_RATIO, (TARGET_CPA_MICROS - cpa) / TARGET_CPA_MICROS * 0.5);
      newCpc = Math.round(kw.currentCpcMicros * (1 + boost));
      reason = `CPA ${Math.round(cpa / 1000)}원 ≤ 목표 ${TARGET_CPA_MICROS / 1000}원 → CPC 상향`;
    }
    // 4. CTR 낮고 전환 없음 → CPC 내림 (최대 -20%)
    else if (ctr < 0.01 && kw.conversions === 0) {
      newCpc = Math.round(kw.currentCpcMicros * (1 - MAX_ADJUST_RATIO));
      reason = `CTR ${(ctr * 100).toFixed(2)}% 저조·전환 없음 → CPC 하향`;
    }
    // 5. CPA 목표 초과 → CPC 내림
    else if (cpa > TARGET_CPA_MICROS * 1.5) {
      const cut = Math.min(MAX_ADJUST_RATIO, (cpa - TARGET_CPA_MICROS) / cpa * 0.3);
      newCpc = Math.round(kw.currentCpcMicros * (1 - cut));
      reason = `CPA ${Math.round(cpa / 1000)}원 과다 → CPC 하향`;
    } else {
      skipped.push({ keywordId: kw.keywordId, reason: '조정 불필요 (성과 정상 범위)' });
      continue;
    }

    // 6. 한도 클램핑
    newCpc = Math.max(MIN_CPC_MICROS, Math.min(MAX_CPC_MICROS, newCpc));

    // 7. 변화 없으면 스킵
    if (newCpc === kw.currentCpcMicros) {
      skipped.push({ keywordId: kw.keywordId, reason: '한도 클램핑 후 변화 없음' });
      continue;
    }

    const changePercent = ((newCpc - kw.currentCpcMicros) / kw.currentCpcMicros) * 100;
    adjustments.push({
      keywordId: kw.keywordId,
      keywordText: kw.keywordText,
      currentCpcMicros: kw.currentCpcMicros,
      newCpcMicros: newCpc,
      reason,
      changePercent: Math.round(changePercent * 10) / 10,
    });
  }

  // 월 예산 초과 시 CPC 상향 조정 모두 제거
  if (spentThisMonthMicros >= MONTHLY_BUDGET_CAP_MICROS * 0.9) {
    const removed = adjustments.filter(a => a.newCpcMicros > a.currentCpcMicros);
    removed.forEach(a => {
      skipped.push({ keywordId: a.keywordId, reason: '월 예산 90% 도달 — CPC 상향 차단' });
    });
    adjustments.splice(0, adjustments.length, ...adjustments.filter(a => a.newCpcMicros <= a.currentCpcMicros));
  }

  const totalBudgetImpactMicros = adjustments.reduce(
    (sum, a) => sum + (a.newCpcMicros - a.currentCpcMicros),
    0,
  );

  return { adjustments, skipped, totalBudgetImpactMicros };
}

// ─── 실제 API 적용 (PUBLISH_ENABLED=true 일 때만) ────────────────────────────

export interface ApplyResult {
  applied: string[];
  failed: { keywordId: string; error: string }[];
}

/**
 * Google Ads API로 CPC 적용.
 * PUBLISH_ENABLED=false(기본)면 드라이런 보고만 반환.
 * Basic 승인 + OAuth 토큰 필요.
 */
export async function applyCpcAdjustments(
  adjustments: CpcAdjustment[],
  customerId: string,
  PUBLISH_ENABLED = false,
): Promise<ApplyResult> {
  if (!PUBLISH_ENABLED) {
    return {
      applied: [],
      failed: adjustments.map(a => ({
        keywordId: a.keywordId,
        error: '사용자 승인 필요 — 실제 CPC 변경 금지',
      })),
    };
  }

  if (adjustments.length === 0) {
    return { applied: [], failed: [] };
  }

  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const accessToken = process.env.GOOGLE_ADS_ACCESS_TOKEN;
  if (!devToken || !accessToken) {
    throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN 또는 GOOGLE_ADS_ACCESS_TOKEN 없음');
  }

  const applied: string[] = [];
  const failed: { keywordId: string; error: string }[] = [];

  for (const adj of adjustments) {
    try {
      const operations = [{
        update: {
          resourceName: `customers/${customerId}/adGroupCriteria/${adj.keywordId}`,
          cpcBidMicros: String(adj.newCpcMicros),
        },
        updateMask: 'cpc_bid_micros',
      }];

      const res = await fetch(
        `https://googleads.googleapis.com/v17/customers/${customerId}/adGroupCriteria:mutate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': devToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ operations }),
        },
      );

      if (res.ok) {
        applied.push(adj.keywordId);
      } else {
        const body = await res.text();
        failed.push({ keywordId: adj.keywordId, error: `${res.status}: ${body.slice(0, 200)}` });
      }
    } catch (e) {
      failed.push({ keywordId: adj.keywordId, error: String(e) });
    }
  }

  return { applied, failed };
}

// ─── 보고서 텍스트 생성 ───────────────────────────────────────────────────────

export function formatAdjustmentReport(result: AdjustmentResult): string {
  const lines: string[] = ['[CPC 자동 조정 보고]'];

  if (result.adjustments.length === 0) {
    lines.push('조정 대상 없음');
  } else {
    lines.push(`조정 ${result.adjustments.length}건:`);
    for (const a of result.adjustments) {
      const dir = a.changePercent > 0 ? '↑' : '↓';
      lines.push(
        `  ${dir} [${a.keywordText}] ${a.currentCpcMicros / 1000}원 → ${a.newCpcMicros / 1000}원 (${a.changePercent > 0 ? '+' : ''}${a.changePercent}%) — ${a.reason}`,
      );
    }
  }

  if (result.skipped.length > 0) {
    lines.push(`\n스킵 ${result.skipped.length}건:`);
    for (const s of result.skipped) {
      lines.push(`  - [${s.keywordId}] ${s.reason}`);
    }
  }

  lines.push(`\n예산 영향: ${result.totalBudgetImpactMicros / 1000}원/클릭 변동`);
  return lines.join('\n');
}
