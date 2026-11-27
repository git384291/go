import 'server-only';
import { NEEDS_REVIEW_GUIDANCE, quotePolicy, renderQuoteMessage } from '@/server/policies';
import type { QuoteRequest, ReasonCode } from '@/server/policies';

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

/**
 * 정책 검증 장애(B, PM 11/24): DB가 이미 승인·유효·게시·유일 버전으로 걸러 준 행을 서버가 다시 검사했는데 통과하지 못한 경우.
 * 조회 실패·형식 오류·충돌 버전·만료/미승인/시작 전/시각 오류 행이 섞여 온 경우다 → 접수까지 막는다.
 * 정책 없음(게시 스위치 OFF 포함)·조건 미상·지역 미확정은 장애가 아니라 정상 '담당자 확인' 상태다(금액 없음, 접수는 독립 안전조건으로 판정).
 */
const FAULT_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'INPUT_INVALID', 'TIME_FORMAT_INVALID', 'TIME_ORDER_INVALID', 'CONFLICTING_VERSIONS', 'NOT_APPROVED', 'SOURCE_NOT_QUOTABLE',
  'CONFIRMED_AT_UNKNOWN', 'CONFIRMED_IN_FUTURE', 'NOT_YET_VALID', 'EXPIRED', 'VALIDITY_UNKNOWN',
]);
/** present: 이 상품 키에 지금 유효한 승인·게시 정책이 하나 있다(PM 11/24 결정: 없으면 접수 차단 — 정책 없음·게시 스위치 OFF 포함) */
export type PolicyCheck = { readonly answer: QuoteAnswer; readonly fault: boolean; readonly present: boolean };

export async function answerQuote(provider: ApprovedPolicyProvider, request: QuoteRequest, now: Date): Promise<QuoteAnswer> {
  return (await checkPolicy(provider, request, now)).answer;
}

/** answerQuote와 같은 안내문 + 정책 검증 장애(B) 여부. 장애여도 안내문은 금액 없는 '담당자 확인' 문장이다 */
export async function checkPolicy(provider: ApprovedPolicyProvider, request: QuoteRequest, now: Date): Promise<PolicyCheck> {
  const fault = (): PolicyCheck => Object.freeze({ answer: closed(), fault: true, present: false });
  try {
    const records = await provider(now);
    if (!Array.isArray(records)) return fault();
    const r = quotePolicy(records, request, now);
    const m = renderQuoteMessage(r);
    if (r.status !== 'quote' || m.kind !== 'quote') {
      if (r.status === 'needs_review' && r.reasons.some((x) => FAULT_REASONS.has(x))) return fault();
      // 조건 미상(요금·지역·결합 등)은 유효 정책은 있으나 담당자 확인 대상. 정책 없음·상품 비활성은 '정책 없음'
      const absent = r.status !== 'needs_review' || r.reasons.some((x) => x === 'NO_POLICY' || x === 'PRODUCT_NOT_ACTIVE');
      return Object.freeze({ answer: m, fault: false, present: !absent });
    }
    const b = r.quote.benefit;
    return Object.freeze({ answer: Object.freeze({ ...m, allow: Object.freeze({
      giftForm: b.form !== 'none' && b.amountKrw > 0 ? b.form : null,
      installFree: r.quote.installFee.amountKrw === 0,
      equipmentFree: r.quote.equipmentMonthlyFee.amountKrw === 0,
    }) }), fault: false, present: true });
  } catch {
    return fault();
  }
}

const closed = (): QuoteAnswer => Object.freeze({ kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });

// 한글 수사 금액("삼만원", "십일만 원")·한글 수사 할인율("십퍼센트")은 값을 확인할 수 없으니 승인 문장에 없으면 막는다
const KO_NUM_WON = /[영일이삼사오육칠팔구십백천만억]+\s*원/;
const KO_NUM_PCT = /[영일이삼사오육칠팔구십백]+\s*(퍼센트|프로|할)/;

// 금전 표현 판별(PM 11/22 B): 숫자를 금액 / 할인율 / 일반 숫자로 나눈다.
// 일반 숫자(24시간·36개월·날짜·500M·3명)는 정상 허용, 금액과 할인율만 승인 문장의 값과 대조한다. 애매하면 금액으로 본다(보수적).
const NUM_TOKEN = /(?:[₩$]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:억|만|천|백))?(?:\s*\d[\d,]*(?:\s*(?:천|백))?)?(?:\s*(?:원|won|krw|usd|달러))?/gi;
const NON_MONEY_AFTER = /^\s*(개월|개|명|건|회|시간|분|초|일|년|월|시|대|가구|세대|메가|기가|채널|mbps|gbps|m\b|g\b|mb|gb|배|번|차|주|세|층|호|동|%|퍼센트|프로|할)/i;
const CURRENCY = /원|won|krw|usd|달러|[₩$]/i;
const UNIT = { 억: 1e8, 만: 1e4, 천: 1e3, 백: 1e2 } as const;
const toNum = (s: string) => Number(s.replace(/,/g, ''));

function tokenValue(tok: string): number {
  const t = tok.replace(/[₩$]|\s+|원|won|krw|usd|달러/gi, '');
  let total = 0; let rest = t;
  for (const u of ['억', '만', '천', '백'] as const) {
    const i = rest.indexOf(u);
    if (i >= 0) { const head = rest.slice(0, i); total += (head === '' ? 1 : toNum(head)) * UNIT[u]; rest = rest.slice(i + 1); }
  }
  return rest === '' ? total : total + toNum(rest);
}

export type MoneyFacts = { readonly won: Set<number>; readonly pct: Set<number> };
export function extractMoneyFacts(text: string): MoneyFacts {
  const won = new Set<number>(); const pct = new Set<number>();
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|퍼센트|프로|할)/g)) pct.add(m[2] === '할' ? Number(m[1]) * 10 : Number(m[1]));
  for (const m of text.matchAll(NUM_TOKEN)) {
    const tok = m[0]; const end = (m.index ?? 0) + tok.length; const after = text.slice(end, end + 6);
    const cur = CURRENCY.test(tok);
    const unit = /[억만천백]/.test(tok);
    if (!cur && NON_MONEY_AFTER.test(after)) continue; // 24시간·36개월·2026년·500M·3명·10%(할인율은 위에서 따로 처리)
    if (!cur && !unit) {
      const digits = tok.replace(/,/g, '');
      if (!tok.includes(',') && digits.length < 4) continue; // 3자리 이하 일반 숫자(24·36·500)
      if (/^(19|20)\d\d$/.test(digits) && /^[-./]\d{1,2}/.test(after)) continue; // 2026-11-23·2026.11.23 날짜 앞머리
      if (/^\d{1,2}[-./]\d{1,2}$/.test(tok) || /^(19|20)\d\d\.\d{1,2}$/.test(tok)) continue; // 11/23·2026.11
    }
    won.add(tokenValue(tok));
  }
  return { won, pct };
}

/** 하위 호환: 금액 값 집합 */
export const extractAmounts = (text: string): Set<number> => extractMoneyFacts(text).won;

export function guardAiReply(aiText: unknown, approved: QuoteAnswer): QuoteAnswer {
  if (typeof aiText !== 'string' || aiText.length > 2000) return closed();
  const ok = approved.kind === 'quote' ? extractMoneyFacts(approved.text) : { won: new Set<number>(), pct: new Set<number>() };
  if (KO_NUM_WON.test(aiText) || KO_NUM_PCT.test(aiText)) return closed();
  const f = extractMoneyFacts(aiText);
  for (const n of f.won) if (!ok.won.has(n)) return closed();
  for (const n of f.pct) if (!ok.pct.has(n)) return closed(); // 할인율은 승인 문장에 있는 값만
  return Object.freeze({ kind: approved.kind, text: aiText });
}
