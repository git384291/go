import 'server-only';
import { NEEDS_REVIEW_GUIDANCE, parseStrictInstant } from './quote';
import type { CustomerQuote, Krw, QuoteResult } from './types';

/**
 * 견적 결과 → 고객 상담창 안내문(순수 함수, PHASE 1: 화면·API 미연결).
 * - 승인·유효 판정을 통과한 CustomerQuote(허용 목록 필드)만 문장으로 만든다. 공급처·버전·수수료·원문 참조는 입력에 없다.
 * - needs_review는 금액을 한 글자도 싣지 않고 고정 안내문만 낸다.
 * - 안내문은 확정 계약·접수 성공을 뜻하지 않는다(정책 기준 시각·필수 고지 포함).
 */
const FORM_LABEL = { gift_card: '상품권', cash: '현금', bill_discount: '요금 할인', none: '없음' } as const;

const won = (k: Krw) => `${k.amountKrw.toLocaleString('en-US')}원(부가세 ${k.vat === 'included' ? '포함' : '별도'})`;

function kst(iso: string): string {
  const t = parseStrictInstant(iso);
  if (t === null) return '확인 필요';
  const d = new Date(t + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function renderQuoteMessage(result: QuoteResult): { readonly kind: 'quote' | 'needs_review'; readonly text: string } {
  if (result.status !== 'quote') return Object.freeze({ kind: 'needs_review', text: NEEDS_REVIEW_GUIDANCE });
  const q: CustomerQuote = result.quote;
  const b = q.benefit;
  const lines = [
    `${q.productLabel} 안내 (정책 기준 ${kst(q.policyConfirmedAt)}, ${kst(q.policyValidUntil)}까지)`,
    `- 월 요금: ${won(q.monthlyFee)}`,
    `- 약정: ${q.contractMonths}개월`,
    `- 장비 월 임대료: ${won(q.equipmentMonthlyFee)}`,
    `- 설치비: ${won(q.installFee)}`,
    `- 결합 전제: ${q.bundlePrerequisites.length ? q.bundlePrerequisites.join(', ') : '없음'}`,
    b.form === 'none' || b.amountKrw === 0
      ? '- 사은품: 없음'
      : `- 사은품: ${b.amountKrw.toLocaleString('en-US')}원 ${FORM_LABEL[b.form]}`
        + ` / 지급 조건: ${b.payoutCondition ?? '담당자가 확인 후 안내'}`
        + ` / 해지·환수: ${b.cancellationCondition ?? '담당자가 확인 후 안내'}`,
    ...q.notices.map((n) => `※ ${n}`),
  ];
  return Object.freeze({ kind: 'quote', text: lines.join('\n') });
}
