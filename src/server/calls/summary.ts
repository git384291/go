import { hasUnmaskedPii, maskTranscript } from './transcriptMask';

/**
 * AI 통화 요약·분류(PM 11/25 ③).
 * - AI 입력: 개인정보 가린 변환문만.
 * - 추측 금지: 상품·상담 결과·재연락 일정은 근거 문장이 변환문 안에 그대로 있을 때만 값으로 남긴다. 아니면 unknown/null.
 *   DB(api.call_summary_complete)도 같은 규칙으로 다시 거부한다(이중 확인).
 * - 비용: 기존 AI 월 한도 원장 예약(hold) → 작업 가져가기 → 실행 → 실제 비용 확정(confirm) / 안 썼으면 취소(release).
 * - 실제 AI 모델 연결은 비용 발생 → PM 승인 전 금지. 지금은 Mock만.
 */
export const PRODUCTS = ['internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other', 'unknown'] as const;
export const OUTCOMES = ['interested', 'applied', 'declined', 'no_answer', 'callback_requested', 'undecided', 'unknown'] as const;
export type Product = (typeof PRODUCTS)[number];
export type Outcome = (typeof OUTCOMES)[number];

export type SummaryValue = {
  product: Product;
  outcome: Outcome;
  callbackEpoch: number | null;
  summary: string;
  evidence: { product?: string; outcome?: string; callback?: string };
};

/** DB core.call_evidence_ok 와 같은 낱말표: 근거에 값과 맞는 낱말이 하나는 있어야 한다 */
const EVIDENCE_WORDS: Record<string, readonly string[]> = {
  'product:internet_tv': ['티비', 'TV', 'tv', '티브이', '테레비', '방송'],
  'product:internet_phone': ['전화', '집전화', '인터넷전화'],
  'product:internet_only': ['인터넷'],
  'product:cctv_security': ['CCTV', 'cctv', '씨씨티비', '보안', '카메라'],
  'product:other': ['다른', '기타', '그 외'],
  'outcome:interested': ['관심', '궁금', '알아보', '하고 싶', '해보고'],
  'outcome:applied': ['신청', '가입', '접수'],
  'outcome:declined': ['안 할', '안할', '안 해', '않', '싫', '필요 없', '필요없', '괜찮습니다', '됐어요'],
  'outcome:no_answer': ['부재', '안 받', '통화 불가', '연결이 안'],
  'outcome:callback_requested': ['다시', '연락', '전화 주', '전화 줘'],
  'outcome:undecided': ['생각해', '고민', '나중', '상의'],
  'callback:set': ['내일', '모레', '오늘', '시에', '시쯤', '요일', '다음 주', '다음주', '오전', '오후', '저녁'],
};
export const evidenceOk = (kind: string, value: string, ev: string) =>
  ev.trim().length >= 4 && (EVIDENCE_WORDS[`${kind}:${value}`] ?? []).some((w) => ev.includes(w));

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= max ? v.trim() : null);

/** 모델 결과(형식 모름)를 규칙에 맞게 정리. 근거가 변환문에 없으면 그 항목은 unknown/null. */
export function sanitizeSummary(raw: unknown, transcriptMasked: string, nowEpoch: number): SummaryValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const rawSummary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!rawSummary) return null;
  const summary = maskTranscript(rawSummary).slice(0, 2000);
  if (hasUnmaskedPii(summary)) return null;
  const ev = (typeof o.evidence === 'object' && o.evidence !== null ? o.evidence : {}) as Record<string, unknown>;
  const grounded = (k: string) => {
    const e = str(ev[k], 300);
    return e && transcriptMasked.includes(e) ? e : null;
  };
  const out: SummaryValue = { product: 'unknown', outcome: 'unknown', callbackEpoch: null, summary, evidence: {} };
  const pe = grounded('product');
  if (pe && typeof o.product === 'string' && (PRODUCTS as readonly string[]).includes(o.product) && o.product !== 'unknown' && evidenceOk('product', o.product, pe)) {
    out.product = o.product as Product;
    out.evidence.product = pe;
  }
  const oe = grounded('outcome');
  if (oe && typeof o.outcome === 'string' && (OUTCOMES as readonly string[]).includes(o.outcome) && o.outcome !== 'unknown' && evidenceOk('outcome', o.outcome, oe)) {
    out.outcome = o.outcome as Outcome;
    out.evidence.outcome = oe;
  }
  const ce = grounded('callback');
  const cb = o.callbackEpoch;
  if (ce && evidenceOk('callback', 'set', ce) && typeof cb === 'number' && Number.isSafeInteger(cb) && cb >= nowEpoch - 86_400 && cb <= nowEpoch + 180 * 86_400) {
    out.callbackEpoch = cb;
    out.evidence.callback = ce;
  }
  return out;
}

export interface SummaryModel {
  readonly name: string;
  summarize(transcriptMasked: string): Promise<{ output: unknown; costKrw: number }>;
}

/** 시험용 모델: 정한 결과를 돌려준다. 외부 호출·비용 없음. */
export class MockSummaryModel implements SummaryModel {
  readonly name = 'mock_summary';
  calls = 0;
  constructor(private readonly make: (t: string) => unknown) {}
  async summarize(t: string) {
    this.calls += 1;
    return { output: this.make(t), costKrw: 0 };
  }
}

export function selectSummaryModel(env: Readonly<Record<string, string | undefined>> = process.env): SummaryModel {
  if ((env.CALL_SUMMARY_MODE ?? 'mock') === 'mock') return new MockSummaryModel(() => ({ summary: '요약 Mock' }));
  throw new Error('LIVE_SUMMARY_NOT_APPROVED');
}

export const SUMMARY_RESERVE_KRW = 20; // 요약 1건 예상 비용 상한(원). 실제 모델 승인 시 단가에 맞춰 조정

export type SummaryClaim = { jobId: string; leaseToken: string; callId: string; transcriptMasked: string };
export type SummaryDeps = {
  model: SummaryModel;
  nowEpoch: () => number;
  aiHold: (costKrw: number) => Promise<string | null>;
  aiConfirm: (reservation: string, actualKrw: number) => Promise<boolean>;
  aiRelease: (reservation: string) => Promise<boolean>;
  claim: (reservation: string) => Promise<SummaryClaim | null>;
  complete: (c: SummaryClaim, v: SummaryValue) => Promise<string>;
  fail: (c: SummaryClaim, code: string, retryable: boolean) => Promise<string>;
};

export async function runSummaryOnce(deps: SummaryDeps): Promise<{ result: string }> {
  const res = await deps.aiHold(SUMMARY_RESERVE_KRW);
  if (!res) return { result: 'budget_blocked' };   // AI 월 한도 초과·0원: 모델 호출 없음
  const c = await deps.claim(res);
  if (!c) {
    await deps.aiRelease(res);
    return { result: 'idle' };
  }
  let out: { output: unknown; costKrw: number };
  try {
    out = await deps.model.summarize(c.transcriptMasked);
  } catch {
    await deps.aiConfirm(res, SUMMARY_RESERVE_KRW);   // 청구 여부 모름 → 예약액으로 보수 확정
    return { result: await deps.fail(c, 'MODEL_ERROR', true) };
  }
  await deps.aiConfirm(res, Math.min(Math.max(0, Math.round(out.costKrw)), 1000));
  const v = sanitizeSummary(out.output, c.transcriptMasked, deps.nowEpoch());
  if (!v) return { result: await deps.fail(c, 'INVALID_MODEL_OUTPUT', true) };
  return { result: await deps.complete(c, v) };
}
