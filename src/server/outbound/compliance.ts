/**
 * 광고성 전화(아웃바운드) 발신 자격 판정 — 순수 함수(외부 호출·DB 없음). 코사장 11/27 지시.
 * 근거(국가법령정보센터, docs/outbound-compliance.md): 정보통신망법 제50조(사전동의·육성 전화권유 예외·수신거부·야간·표시·자동생성 금지),
 * 방문판매법 제5조(전화권유판매업 신고)·제42조(수신거부 의사 등록시스템 = 두낫콜 확인·발신 금지).
 * ⚠ 법률 자문 전 운영 금지. 이 모듈은 '막는 쪽'만 구현한다 — 하나라도 미확인·조회 실패면 차단(fail-closed).
 *
 * 원칙
 * - 번호를 만들지 않는다: 이 모듈에는 번호 생성·순차 생성·외부 목록 자동 등록 기능이 없다. 대상은 적법하게 확보된 목록(출처 기록 포함)뿐이고,
 *   '무작위'는 그 목록 안에서 순서만 섞는다(planDialOrder).
 * - ARS(자동 음성) 광고: 명시적 사전동의 증거가 있는 번호만.
 * - 육성 전화권유 예외(상담원이 직접 통화): 신고 확인 + 적법 수집출처 + 통화 시작 고지(상호·목적·수집출처) + 두낫콜 최신 조회 '등록 안 됨'
 *   + 내부 수신거부 없음 + 실제 상담원 연결이 모두 확인될 때만. 예측발신(PDS)은 상담원 예약이 확인된 경우에만 육성으로 본다.
 * - 08:00~21:00(KST)만. 야간 별도 동의 기능은 열지 않는다.
 * - 발신번호·상호 표시 필수. 수신거부는 즉시·영구 차단. 재시도 상한. 감사 기록은 연락처 HMAC·사유만(전화번호 원문 없음).
 */

export const OUTBOUND_RULES = {
  startHourKst: 8,          // 포함
  endHourKst: 21,           // 미포함(21:00부터 차단)
  maxAttemptsPerTarget: 3,
  minRetryIntervalMs: 24 * 3_600_000,
  dncMaxAgeMs: 24 * 3_600_000, // 내부 정책: 두낫콜 조회는 발신 24시간 이내 결과만 인정(법정 주기보다 엄격하게 운영)
} as const;

export type CallMode = 'ars_ad' | 'live_agent';
export type Dialer = 'manual' | 'pds';
/** 수집출처 종류. generated·sequential·external_auto_import는 법 제50조 제5항 금지 행위라 항상 거부 */
export type SourceKind = 'customer_inquiry' | 'consent_form' | 'existing_customer' | 'generated' | 'sequential' | 'external_auto_import' | 'unknown';
export const FORBIDDEN_SOURCES: readonly SourceKind[] = ['generated', 'sequential', 'external_auto_import', 'unknown'];

export type Target = {
  phoneHmac: string;                       // 연락처 HMAC(원문 없음)
  source: { kind: SourceKind; recordId: string; lawfulVerified: boolean; label: string };
  adConsent: { explicit: true; channel: 'phone'; evidenceId: string; at: Date; withdrawnAt: Date | null } | null;
  attempts: number;
  lastAttemptAt: Date | null;
};

export type DncStatus = { result: 'clear' | 'listed' | 'unknown' | 'error'; checkedAt: Date | null };

export type CallContext = {
  now: Date;
  mode: CallMode;
  dialer: Dialer;
  seller: { telemarketingRegistered: boolean | null; registrationNo: string | null };
  disclosure: { businessName: string; purpose: string; announcesSource: boolean };
  callerIdShown: boolean;
  businessNameShown: boolean;
  agentConnected: boolean | null;   // live_agent: 실제 상담원이 통화에 연결됨(확인 못 하면 null)
  agentReserved: boolean | null;    // pds: 발신 전에 상담원이 예약됨(무응답 끊김 방지)
  dnc: DncStatus;
  internalOptOut: boolean;          // 내부 수신거부·동의철회(영구 차단 목록)
};

export type Reason =
  | 'NIGHT_BLOCKED' | 'OPTED_OUT' | 'FORBIDDEN_SOURCE' | 'SOURCE_UNVERIFIED' | 'NO_PRIOR_CONSENT' | 'CONSENT_WITHDRAWN'
  | 'NOT_REGISTERED' | 'DISCLOSURE_MISSING' | 'DNC_LISTED' | 'DNC_UNCONFIRMED' | 'AGENT_NOT_CONNECTED' | 'PDS_REQUIRES_AGENT'
  | 'CALLER_ID_REQUIRED' | 'RETRY_LIMIT' | 'RETRY_TOO_SOON' | 'INVALID_INPUT';

export type Decision = { allowed: boolean; basis: 'consent' | 'live_exception' | null; reasons: Reason[] };

const HMAC = /^[0-9a-f]{64}$/;
const kstHour = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).getUTCHours();
const nonEmpty = (s: unknown) => typeof s === 'string' && s.trim().length > 0;

export function withinCallingHours(now: Date): boolean {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const h = kstHour(now);
  return h >= OUTBOUND_RULES.startHourKst && h < OUTBOUND_RULES.endHourKst;
}

function validConsent(t: Target): boolean {
  const c = t.adConsent;
  return !!c && c.explicit === true && c.channel === 'phone' && nonEmpty(c.evidenceId) && c.at instanceof Date && !Number.isNaN(c.at.getTime()) && c.withdrawnAt === null;
}

function dncFresh(d: DncStatus, now: Date): boolean {
  if (d.result !== 'clear' || !(d.checkedAt instanceof Date)) return false;
  const age = now.getTime() - d.checkedAt.getTime();
  return age >= 0 && age <= OUTBOUND_RULES.dncMaxAgeMs;
}

/** 대상 1건 발신 판정. 모든 실패 사유를 모아 돌려준다(사유가 하나라도 있으면 차단). */
export function decideOutbound(t: Target, ctx: CallContext): Decision {
  const r = new Set<Reason>();
  if (!t || !HMAC.test(t.phoneHmac ?? '') || !t.source || !ctx || !(ctx.now instanceof Date) || Number.isNaN(ctx.now.getTime())
    || (ctx.mode !== 'ars_ad' && ctx.mode !== 'live_agent') || (ctx.dialer !== 'manual' && ctx.dialer !== 'pds')) {
    return { allowed: false, basis: null, reasons: ['INVALID_INPUT'] };
  }
  if (!withinCallingHours(ctx.now)) r.add('NIGHT_BLOCKED');
  if (ctx.internalOptOut) r.add('OPTED_OUT');
  if (FORBIDDEN_SOURCES.includes(t.source.kind)) r.add('FORBIDDEN_SOURCE');
  if (t.source.lawfulVerified !== true || !nonEmpty(t.source.recordId) || !nonEmpty(t.source.label)) r.add('SOURCE_UNVERIFIED');
  if (t.adConsent && t.adConsent.withdrawnAt !== null) r.add('CONSENT_WITHDRAWN');
  if (!ctx.callerIdShown || !ctx.businessNameShown || !nonEmpty(ctx.disclosure?.businessName)) r.add('CALLER_ID_REQUIRED');
  if (!Number.isInteger(t.attempts) || t.attempts < 0) r.add('INVALID_INPUT');
  else if (t.attempts >= OUTBOUND_RULES.maxAttemptsPerTarget) r.add('RETRY_LIMIT');
  if (t.lastAttemptAt && ctx.now.getTime() - t.lastAttemptAt.getTime() < OUTBOUND_RULES.minRetryIntervalMs) r.add('RETRY_TOO_SOON');
  // 두낫콜(방문판매법 제42조): 동의 여부와 관계없이 최신 조회 '등록 안 됨'만 통과(엄격 운영)
  if (ctx.dnc.result === 'listed') r.add('DNC_LISTED');
  else if (!dncFresh(ctx.dnc, ctx.now)) r.add('DNC_UNCONFIRMED');
  if (ctx.dialer === 'pds' && (ctx.mode !== 'live_agent' || ctx.agentReserved !== true)) r.add('PDS_REQUIRES_AGENT');

  let basis: Decision['basis'] = null;
  if (ctx.mode === 'ars_ad') {
    // 자동 음성 광고는 육성 예외가 없다 → 명시적 사전동의만
    if (!validConsent(t)) r.add('NO_PRIOR_CONSENT'); else basis = 'consent';
  } else if (validConsent(t)) {
    basis = 'consent';
    if (ctx.agentConnected !== true) r.add('AGENT_NOT_CONNECTED');
  } else {
    // 육성 전화권유 예외(정보통신망법 제50조 제1항 단서 + 방문판매법 제5조): 모두 확인돼야 함
    if (ctx.seller.telemarketingRegistered !== true || !nonEmpty(ctx.seller.registrationNo)) r.add('NOT_REGISTERED');
    if (!nonEmpty(ctx.disclosure?.purpose) || ctx.disclosure?.announcesSource !== true || !nonEmpty(ctx.disclosure?.businessName)) r.add('DISCLOSURE_MISSING');
    if (ctx.agentConnected !== true) r.add('AGENT_NOT_CONNECTED');
    basis = 'live_exception';
  }
  const reasons = [...r];
  return { allowed: reasons.length === 0, basis: reasons.length === 0 ? basis : null, reasons };
}

/**
 * 발신 순서 정하기: 주어진 목록에서 판정 통과 대상만 남기고 순서만 섞는다. 새 번호를 만들지 않는다(출력은 입력의 부분집합).
 * 같은 HMAC 중복은 1건만. rng는 [0,1) 함수(시험에서 고정).
 */
export function planDialOrder(targets: readonly Target[], ctxFor: (t: Target) => CallContext, rng: () => number = Math.random): Target[] {
  const seen = new Set<string>();
  const ok: Target[] = [];
  for (const t of targets) {
    if (!t || seen.has(t.phoneHmac)) continue;
    seen.add(t.phoneHmac);
    if (decideOutbound(t, ctxFor(t)).allowed) ok.push(t);
  }
  for (let i = ok.length - 1; i > 0; i--) {
    const j = Math.floor(Math.min(Math.max(rng(), 0), 0.999999999) * (i + 1));
    [ok[i], ok[j]] = [ok[j], ok[i]];
  }
  return ok;
}

/** 영구 수신거부 목록(즉시 반영). 해제 함수는 두지 않는다 — 다시 받으려면 새 명시 동의 절차가 필요(별도 승인). */
export class SuppressionList {
  private readonly s = new Set<string>();
  add(phoneHmac: string): void { if (HMAC.test(phoneHmac)) this.s.add(phoneHmac); else throw new Error('INVALID_INPUT'); }
  has(phoneHmac: string): boolean { return this.s.has(phoneHmac); }
  get size(): number { return this.s.size; }
}

/** 결정 감사 기록: 연락처 HMAC·사유·근거만(전화번호 원문·이름·고지 문구 없음) */
export type OutboundAudit = { at: string; phoneHmac: string; mode: CallMode; dialer: Dialer; allowed: boolean; basis: Decision['basis']; reasons: Reason[] };
export function auditRecord(t: Target, ctx: CallContext, d: Decision): OutboundAudit {
  return { at: ctx.now.toISOString(), phoneHmac: t.phoneHmac, mode: ctx.mode, dialer: ctx.dialer, allowed: d.allowed, basis: d.basis, reasons: [...d.reasons] };
}
