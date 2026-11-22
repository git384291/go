import 'server-only';
import { NEEDS_REVIEW_GUIDANCE, quotePolicy, renderQuoteMessage } from '@/server/policies';
import type { QuoteRequest } from '@/server/policies';

/**
 * 상담창 금액 안내(PM 11/21 1·2·7항) — 승인된 정책 견적에서 나온 문장만 고객에게 간다.
 * - 정책 공급자(provider)는 검수 저장소에서 '승인된 레코드'만 돌려주는 주입 함수다. 기본값은 빈 목록이라 항상 '담당자 확인' 안내다.
 * - 공급자 오류·형식 오류는 모두 같은 안내로 닫는다(fail-closed). 오류 내용은 고객에게 내보내지 않는다.
 * - guardAiReply: AI가 쓴 문장 안의 금액은 승인 견적 문장에 있는 금액과 일치해야 한다. 하나라도 벗어나면 답 전체를 안내문으로 바꾼다.
 */
export type ApprovedPolicyProvider = (now: Date) => readonly unknown[] | Promise<readonly unknown[]>;
export const NO_APPROVED_POLICIES: ApprovedPolicyProvider = () => [];

/** 서버가 승인 정책 값으로 계산한 '안내해도 되는 혜택'(PM 11/22 P1). AI 답변의 혜택 약속은 이것과 대조한다(문장 키워드 일치로 승인하지 않음) */
export type BenefitAllowance = {
  readonly giftForm: 'gift_card' | 'cash' | 'bill_discount' | null; // 사은품 형태(금액 > 0일 때만)
  readonly installFree: boolean;   // 승인 설치비가 0원
  readonly equipmentFree: boolean; // 승인 장비 임대료가 0원
};
export type QuoteAnswer = { readonly kind: 'quote' | 'needs_review'; readonly text: string; readonly allow?: BenefitAllowance };

export async function answerQuote(provider: ApprovedPolicyProvider, request: QuoteRequest, now: Date): Promise<QuoteAnswer> {
  try {
    const records = await provider(now);
    if (!Array.isArray(records)) return closed();
    const r = quotePolicy(records, request, now);
    const m = renderQuoteMessage(r);
    if (r.status !== 'quote' || m.kind !== 'quote') return m;
    const b = r.quote.benefit;
    return Object.freeze({ ...m, allow: Object.freeze({
      giftForm: b.form !== 'none' && b.amountKrw > 0 ? b.form : null,
      installFree: r.quote.installFee.amountKrw === 0,
      equipmentFree: r.quote.equipmentMonthlyFee.amountKrw === 0,
    }) });
  } catch {
    return closed();
  }
}

const closed = (): QuoteAnswer => Object.freeze({ kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });

// 한글 수사 금액("삼만원", "십일만 원")은 값을 확인할 수 없으니 승인 문장에 없으면 막는다
const KO_NUM_WON = /[영일이삼사오육칠팔구십백천만억]+\s*원/;
const WON = /(\d[\d,]*)\s*(만\s*원|천\s*원|원)/g;
const BARE = /\d[\d,]{3,}/g; // 쉼표 포함 4자리 이상 숫자는 금액일 수 있어 같은 규칙을 적용한다

const toNum = (s: string) => Number(s.replace(/,/g, ''));

export function extractAmounts(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(WON)) {
    const n = toNum(m[1]);
    out.add(m[2].startsWith('만') ? n * 10000 : m[2].startsWith('천') ? n * 1000 : n);
  }
  for (const m of text.matchAll(BARE)) out.add(toNum(m[0]));
  return out;
}

export function guardAiReply(aiText: unknown, approved: QuoteAnswer): QuoteAnswer {
  if (typeof aiText !== 'string' || aiText.length > 2000) return closed();
  const allowed = approved.kind === 'quote' ? extractAmounts(approved.text) : new Set<number>();
  if (KO_NUM_WON.test(aiText) && approved.kind !== 'quote') return closed();
  if (KO_NUM_WON.test(aiText)) return closed();
  for (const n of extractAmounts(aiText)) if (!allowed.has(n)) return closed();
  return Object.freeze({ kind: approved.kind, text: aiText });
}
