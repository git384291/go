// 광고비 지출 감시 판정(PM 11/21 4항) — 순수 함수. 외부 호출·집행·과금 없음.
// - 한도는 campaignDraft의 승인 상한(일 10,000원·첫 3일 30,000원)을 그대로 쓴다. 입력으로 한도를 올릴 수 없다(초과 입력은 거부).
// - 지출 값이 없거나 형식이 틀리면 '정상'으로 보지 않는다. fail-closed: STOP_REQUIRED(UNKNOWN_SPEND).
// - 이 판정은 중단 '요청이 필요함'만 알린다. 실제 중단 요청 모형은 searchAdStop, 집행 허용은 campaignDraft(항상 false)가 맡는다.
import { AD_DAILY_CAP_KRW, AD_FIRST3DAYS_CAP_KRW } from './campaignDraft';

export const WARN_RATIO = 0.8;

export type SpendDay = { readonly date: string; readonly spendKrw: number | null };
export type GuardInput = {
  readonly dailyCapKrw: number;
  readonly totalCapKrw: number;
  readonly days: readonly SpendDay[];
};
export type GuardReason = 'DAILY_CAP_REACHED' | 'TOTAL_CAP_REACHED' | 'UNKNOWN_SPEND' | 'DUPLICATE_DATE' | 'DAILY_NEAR_CAP' | 'TOTAL_NEAR_CAP';
export type GuardResult =
  | { readonly ok: false; readonly error: 'INVALID_INPUT' }
  | { readonly ok: true; readonly action: 'OK' | 'WARN' | 'STOP_REQUIRED'; readonly reasons: readonly GuardReason[]; readonly totalSpendKrw: number | null };

const INVALID: GuardResult = Object.freeze({ ok: false, error: 'INVALID_INPUT' });
const isWon = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;
const isDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

export function judgeSpend(input: unknown): GuardResult {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return INVALID;
    const o = input as Record<string, unknown>;
    if (Object.keys(o).sort().join() !== 'dailyCapKrw,days,totalCapKrw') return INVALID;
    if (!isWon(o.dailyCapKrw, AD_DAILY_CAP_KRW) || !isWon(o.totalCapKrw, AD_FIRST3DAYS_CAP_KRW)) return INVALID;
    if (!Array.isArray(o.days) || o.days.length < 1 || o.days.length > 3) return INVALID;
    const reasons = new Set<GuardReason>();
    const seen = new Set<string>();
    let total = 0;
    let unknown = false;
    for (const d of o.days as unknown[]) {
      if (typeof d !== 'object' || d === null || Array.isArray(d)) return INVALID;
      const r = d as Record<string, unknown>;
      if (Object.keys(r).sort().join() !== 'date,spendKrw' || !isDate(r.date)) return INVALID;
      if (seen.has(r.date)) { reasons.add('DUPLICATE_DATE'); unknown = true; continue; }
      seen.add(r.date);
      if (r.spendKrw === null) { unknown = true; continue; }
      if (typeof r.spendKrw !== 'number' || !Number.isSafeInteger(r.spendKrw) || r.spendKrw < 0) return INVALID;
      total += r.spendKrw;
      if (r.spendKrw >= o.dailyCapKrw) reasons.add('DAILY_CAP_REACHED');
      else if (r.spendKrw >= o.dailyCapKrw * WARN_RATIO) reasons.add('DAILY_NEAR_CAP');
    }
    if (unknown) reasons.add('UNKNOWN_SPEND');
    if (total >= o.totalCapKrw) reasons.add('TOTAL_CAP_REACHED');
    else if (total >= o.totalCapKrw * WARN_RATIO) reasons.add('TOTAL_NEAR_CAP');
    const stop = ['DAILY_CAP_REACHED', 'TOTAL_CAP_REACHED', 'UNKNOWN_SPEND', 'DUPLICATE_DATE'].some((x) => reasons.has(x as GuardReason));
    const action = stop ? 'STOP_REQUIRED' : reasons.size > 0 ? 'WARN' : 'OK';
    return Object.freeze({ ok: true, action, reasons: Object.freeze([...reasons]), totalSpendKrw: unknown ? null : total });
  } catch {
    return INVALID;
  }
}
