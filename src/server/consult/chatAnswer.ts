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

const BENEFIT_WORDS = /사은품|상품권|현금|지원금|캐시백|할인|무료|공짜/;

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
    if (approved.kind !== 'quote' && BENEFIT_WORDS.test(reply)) return fallback();
    return { ok: true, kind: guarded.kind, text: guarded.text, source: 'model', next: 'signup' };
  } catch (e) {
    // 요청을 보내기 전 실패(설정 누락 등)만 취소하고, 시간 초과·응답 오류는 비용이 났을 수 있어 확정한다
    if (e instanceof ModelNotCalledError) await hold.cancel(); else await hold.confirm(model.costPerCallKrw);
    return fallback();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
