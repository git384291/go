import 'server-only';
import { checkPolicy, guardAiReply } from './quoteAnswer';
import { AI_UNAVAILABLE_GUIDANCE, POLICY_UNVERIFIED_GUIDANCE } from '@/content/consultGuidance';
import type { ApprovedPolicyProvider, QuoteAnswer } from './quoteAnswer';
import { maskPii } from './piiMask';
import { SYSTEM_PROMPT } from './chatModel';
import { grantBudgetPermit, ModelNotCalledError, revokeBudgetPermit } from './chatModel';
import type { AiBudget, CallMeter, ChatModel, ReserveContext } from './chatModel';
import { ModelCallError } from './modelRecovery';

/**
 * AI 24시간 상담 답변(PM 11/21 ②). 요금·사은품은 승인된 정책 견적 문장에서만 나온다.
 * 흐름: 입력 검사 → 승인 견적(서버) → [예산·모델 가능하면] 가린 글+견적 문장만 모델에 전달 → 금액·혜택 가드 → 통과 못 하면 견적/안전 안내문.
 * 가드 실패는 승인 안내문(없으면 '담당자 확인')으로 닫는다. 오류 내용은 고객에게 내보내지 않는다.
 * PM 11/24: 모델 없음·한도·장애·시간 초과는 A 안내(AI 상담 장애, 승인 견적이 있으면 그 문장만 덧붙임),
 * 정책 검증 장애(조회 실패·충돌·만료/미승인 행 등)는 모델을 부르지 않고 B 안내 + next 'blocked'(화면 접수 잠금, 서버·DB도 접수 차단).
 */
export type ChatDeps = {
  readonly provider: ApprovedPolicyProvider;
  readonly supplierId: string;
  readonly model: ChatModel | null;
  readonly budget: AiBudget;
  readonly timeoutMs?: number;
};
export type ChatInput = {
  readonly message: unknown; readonly carrier: string; readonly productId: string; readonly regionCode: string;
  /** 0028: 예약 문맥(요청 ID·사용자 키). 없으면 DB 예약은 거부된다(메모리 시험 예산은 문맥 없이도 동작) */
  readonly budgetCtx?: ReserveContext;
};
export type ChatReply =
  | { readonly ok: false; readonly code: 'INVALID_INPUT' }
  | { readonly ok: true; readonly kind: QuoteAnswer['kind']; readonly text: string; readonly source: 'model' | 'fallback'; readonly next: 'signup' | 'callback' | 'blocked'; readonly callbackPrompt?: string };

/** PM 11/22 ② 7: 승인 견적으로 답할 수 없거나 고객이 잘 모르겠다고 하면 대표 직접 연락 동의를 묻는다(동의는 신청 양식의 체크로만 받는다) */
export const CALLBACK_PROMPT = '대표가 직접 연락드려도 될까요? 동의하시면 아래 신청 양식에서 "대표 직접 연락에 동의합니다"를 선택해 주세요.';
const UNSURE = /모르|모르겠|헷갈|어렵|복잡|어떻게\s*해야|뭐가\s*좋|추천해|글쎄|확실하지|이해가\s*안/;
export function needsCallback(message: string, kind: QuoteAnswer['kind']): boolean { return kind !== 'quote' || UNSURE.test(message); }
const withCallback = (r: Extract<ChatReply, { ok: true }>, message: string): ChatReply => needsCallback(message, r.kind) ? { ...r, next: 'callback', callbackPrompt: CALLBACK_PROMPT } : r;

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

/** 상담 1회 전체 시간 상한: 기본 8초, 어떤 설정도 10초를 넘을 수 없다(복구 재시도 포함 모든 시도가 이 안에서 끝난다) */
export const CHAT_TIMEOUT_DEFAULT_MS = 8000;
export const CHAT_TIMEOUT_MAX_MS = 10_000;
export function chatTimeoutMs(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(CHAT_TIMEOUT_MAX_MS, Math.trunc(v)) : CHAT_TIMEOUT_DEFAULT_MS;
}

const isUncertain = (e: unknown): boolean =>
  (e instanceof Error && e.message === 'TIMEOUT') || (e instanceof ModelCallError && (e.kind === 'timeout' || e.kind === 'network'));

export async function answerChat(deps: ChatDeps, input: ChatInput, now: Date): Promise<ChatReply> {
  const m = input.message;
  if (typeof m !== 'string' || m.trim().length < 1 || m.length > 300) return { ok: false, code: 'INVALID_INPUT' };
  const checked = await checkPolicy(deps.provider, {
    supplierId: deps.supplierId, segment: 'household', carrier: input.carrier, productId: input.productId, regionCode: input.regionCode, confirmedBundles: { known: false },
  }, now);
  if (checked.fault) return { ok: true, kind: 'needs_review', text: POLICY_UNVERIFIED_GUIDANCE, source: 'fallback', next: 'blocked' };
  const approved = checked.answer;
  // PM 11/24 결정: 유효한 게시 정책이 없으면(정책 없음·게시 스위치 OFF) 일반 상담 안내는 그대로 하되 접수는 잠근다(next 'blocked', 연락 동의 질문 없음)
  const gate = (r: ChatReply): ChatReply => (r.ok && !checked.present ? { ok: true, kind: r.kind, text: r.text, source: r.source, next: 'blocked' } : r);
  const fallback = (): ChatReply => gate(withCallback({ ok: true, kind: approved.kind, text: approved.text, source: 'fallback', next: 'signup' }, m));
  // A: AI 상담만 실패. 승인 견적(서버 검증 통과)이 있으면 그 문장만 덧붙이고, 없으면 금액 없는 A 안내만
  const unavailable = (): ChatReply => gate(withCallback({ ok: true, kind: approved.kind, text: approved.kind === 'quote' ? `${AI_UNAVAILABLE_GUIDANCE}\n\n${approved.text}` : AI_UNAVAILABLE_GUIDANCE, source: 'fallback', next: 'signup' }, m));
  const model = deps.model;
  if (!model) return unavailable();
  const hold = await deps.budget.reserve(model.costPerCallKrw, input.budgetCtx);
  if (!hold) return unavailable();
  const ctl = new AbortController();
  const meter: CallMeter = { sent: 0 };
  grantBudgetPermit(meter); // 공통 비용 게이트: 예약이 성공한 이 호출에만 전송 허가
  // 확정 비용: 재시도 래퍼가 센 전송 횟수만큼(예약 이하). 세지 않는 모델은 예약 전액(보수적)
  const spent = () => (model.attemptCostKrw && meter.sent > 0 ? Math.min(model.costPerCallKrw, model.attemptCostKrw * meter.sent) : model.costPerCallKrw);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      model.generate({ system: SYSTEM_PROMPT, user: maskPii(m), approved: approved.text }, ctl.signal, meter),
      new Promise<never>((_, rej) => { timer = setTimeout(() => { rej(new Error('TIMEOUT')); ctl.abort(); }, chatTimeoutMs(deps.timeoutMs)); }),
    ]);
    await hold.confirm(spent());
    const guarded = guardAiReply(reply, approved);
    if (guarded.text !== reply) return fallback();
    if (!benefitClaimsAllowed(reply, approved)) return fallback();
    return gate(withCallback({ ok: true, kind: guarded.kind, text: guarded.text, source: 'model', next: 'signup' }, m));
  } catch (e) {
    // 요청을 보내기 전 실패(설정 누락 등)만 취소하고, 시간 초과·응답 오류는 비용이 났을 수 있어 확정한다
    // 0028: 시간 초과·연결 끊김은 과금 여부를 알 수 없다 → 예약 전액으로 닫고 대표 조정 대기(환불하지 않음)
    if (e instanceof ModelNotCalledError) await hold.cancel();
    else if (isUncertain(e) && hold.uncertain) await hold.uncertain();
    else await hold.confirm(spent());
    return unavailable();
  } finally {
    revokeBudgetPermit(meter);
    if (timer) clearTimeout(timer);
  }
}
