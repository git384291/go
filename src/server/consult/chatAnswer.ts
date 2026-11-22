import 'server-only';
import { answerQuote, guardAiReply } from './quoteAnswer';
import type { ApprovedPolicyProvider, QuoteAnswer } from './quoteAnswer';
import { maskPii } from './piiMask';
import { SYSTEM_PROMPT } from './chatModel';
import { ModelNotCalledError } from './chatModel';
import type { AiBudget, ChatModel } from './chatModel';

/**
 * AI 24시간 상담 답변(PM 11/21 ②). 요금·사은품은 승인된 정책 견적 문장에서만 나온다.
 * 흐름: 입력 검사 → 승인 견적(서버) → [예산·모델 가능하면] 가린 글+견적 문장만 모델에 전달 → 금액·혜택 가드 → 통과 못 하면 견적/안전 안내문.
 * 모델 장애·시간 초과·한도 초과·가드 실패는 모두 승인 안내문(없으면 '담당자 확인')으로 닫는다. 오류 내용은 고객에게 내보내지 않는다.
 */
export type ChatDeps = {
  readonly provider: ApprovedPolicyProvider;
  readonly supplierId: string;
  readonly model: ChatModel | null;
  readonly budget: AiBudget;
  readonly timeoutMs?: number;
};
export type ChatInput = { readonly message: unknown; readonly carrier: string; readonly productId: string; readonly regionCode: string };
export type ChatReply =
  | { readonly ok: false; readonly code: 'INVALID_INPUT' }
  | { readonly ok: true; readonly kind: QuoteAnswer['kind']; readonly text: string; readonly source: 'model' | 'fallback'; readonly next: 'signup' };

// 혜택 약속 검사(PM 11/22 P1): 견적 유무와 관계없이, AI가 말한 혜택은 서버가 승인 정책 값으로 계산한 허용치(allow)와 대조한다.
// 띄어쓰기·기호로 쪼갠 우회("상 품-권")를 막으려고 글자·숫자만 남겨 비교한다. 확인할 수 없으면 막고 승인 안내문(fallback)으로 닫는다.
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const GIFT_CARD = /상품권|기프트|기프티콘|giftcard|쿠폰|바우처|모바일교환권/;
const CASH = /현금|캐시백|페이백|지원금|돈을?드|입금해|계좌로|환급|리워드|포인트|용돈/;
const DISCOUNT = /할인|깎아|에누리|감면|인하해|반값|세일|프로모션|특가/;
const GENERIC = /사은품|사은|선물|증정|경품|혜택|덤으로|웰컴|이벤트/;
const FREE = /무료|공짜|무상|면제|공으로|서비스로|안받|부담없|(?<!\d)0원/g;
const EXTRA = /추가|더드|더많이|더챙|플러스|별도로드|또드|두배|2배/;
export function benefitClaimsAllowed(reply: string, approved: QuoteAnswer): boolean {
  const t = norm(reply);
  const a = approved.kind === 'quote' ? approved.allow : undefined;
  const gift = GIFT_CARD.test(t), cash = CASH.test(t), disc = DISCOUNT.test(t), generic = GENERIC.test(t);
  if (!a) return !(gift || cash || disc || generic || [...t.matchAll(FREE)].length > 0); // 견적 없음·조회 실패: 혜택 언급 자체를 막는다
  if (gift && a.giftForm !== 'gift_card') return false;
  if (cash && a.giftForm !== 'cash') return false;
  if (disc && a.giftForm !== 'bill_discount') return false;
  if (generic && a.giftForm === null) return false;
  if ((gift || cash || disc || generic) && EXTRA.test(t)) return false; // "추가 상품권"·"더 드려요" 등 승인 밖 추가 혜택
  for (const m of t.matchAll(FREE)) {
    const i = m.index ?? 0; const w = t.slice(Math.max(0, i - 8), i + m[0].length + 8);
    const ok = (a.installFree && /설치비|설치비용|설치요금/.test(w)) || (a.equipmentFree && /임대료|임대비|장비비/.test(w));
    if (!ok) return false; // 승인 설치비·장비 임대료가 0원이고 바로 옆에서 그 요금 항목을 말할 때만 '무료' 허용(장비 '무상 제공' 등 소유·증정 약속은 불가)
  }
  return true;
}

export async function answerChat(deps: ChatDeps, input: ChatInput, now: Date): Promise<ChatReply> {
  const m = input.message;
  if (typeof m !== 'string' || m.trim().length < 1 || m.length > 300) return { ok: false, code: 'INVALID_INPUT' };
  const approved = await answerQuote(deps.provider, {
    supplierId: deps.supplierId, segment: 'household', carrier: input.carrier, productId: input.productId, regionCode: input.regionCode, confirmedBundles: { known: false },
  }, now);
  const fallback = (): ChatReply => ({ ok: true, kind: approved.kind, text: approved.text, source: 'fallback', next: 'signup' });
  const model = deps.model;
  if (!model) return fallback();
  const hold = await deps.budget.reserve(model.costPerCallKrw);
  if (!hold) return fallback();
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      model.generate({ system: SYSTEM_PROMPT, user: maskPii(m), approved: approved.text }, ctl.signal),
      new Promise<never>((_, rej) => { timer = setTimeout(() => { rej(new Error('TIMEOUT')); ctl.abort(); }, deps.timeoutMs ?? 8000); }),
    ]);
    await hold.confirm(model.costPerCallKrw);
    const guarded = guardAiReply(reply, approved);
    if (guarded.text !== reply) return fallback();
    if (!benefitClaimsAllowed(reply, approved)) return fallback();
    return { ok: true, kind: guarded.kind, text: guarded.text, source: 'model', next: 'signup' };
  } catch (e) {
    // 요청을 보내기 전 실패(설정 누락 등)만 취소하고, 시간 초과·응답 오류는 비용이 났을 수 있어 확정한다
    if (e instanceof ModelNotCalledError) await hold.cancel(); else await hold.confirm(model.costPerCallKrw);
    return fallback();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
