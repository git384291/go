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
 * - 전화권유판매업 신고: 예외 해당 여부를 법률 자문으로 확정하기 전까지 모든 발신 모드에서 신고·신고번호를 필수로 한다.
 * - 육성 전화권유 예외(상담원이 직접 통화): 신고 확인 + 적법 수집출처 + 통화 시작 고지(상호·목적·수집출처) + 두낫콜 최신 조회 '등록 안 됨'
 *   + 내부 수신거부 없음 + 사람 상담원 배정·대기(humanAgentReady)가 모두 확인될 때만. 예측발신(PDS)은 상담원 예약(agentReserved)도 필수.
 *   발신 뒤 실제 연결은 dial 계약(providers.ts): live_agent는 자동음성 금지, 응답 시 배정된 사람 상담원에게만 연결.
 * - 08:00~21:00(KST)만. 야간 별도 동의 기능은 열지 않는다.
 * - 발신번호·상호 표시 필수. 수신거부는 저장소 조회 결과(5분 이내 clear)만 통과 — 지속 저장소는 아직 없음(닫힌 Mock, 별도 마이그레이션 필요).
 * - 재시도 상한. 감사 기록은 연락처 HMAC·사유만(전화번호 원문 없음). 런타임 형태가 어긋나면 예외 없이 INVALID_INPUT.
 */

export const OUTBOUND_RULES = {
  startHourKst: 8,          // 포함
  endHourKst: 21,           // 미포함(21:00부터 차단)
  maxAttemptsPerTarget: 3,
  minRetryIntervalMs: 24 * 3_600_000,
  dncMaxAgeMs: 24 * 3_600_000, // 내부 정책: 두낫콜 조회는 발신 24시간 이내 결과만 인정(법정 주기보다 엄격하게 운영)
  suppressionMaxAgeMs: 5 * 60_000, // 내부 수신거부 조회는 발신 직전 5분 이내 결과만 인정
} as const;

export type CallMode = 'ars_ad' | 'live_agent';
export type Dialer = 'manual' | 'pds';
/**
 * 수집출처: 허용 목록(allowlist)만 통과. 그 밖의 모든 값(generated·sequential·external_auto_import·scraped·미지 값)은 거부 —
 * 법 제50조 제5항(자동 생성·자동 등록) 및 출처 불명 차단.
 */
export const ALLOWED_SOURCES = ['customer_inquiry', 'consent_form', 'existing_customer'] as const;
export type SourceKind = (typeof ALLOWED_SOURCES)[number];

export type Target = {
  phoneHmac: string;                       // 연락처 HMAC(원문 없음)
  source: { kind: SourceKind; recordId: string; lawfulVerified: boolean; label: string };
  /** 명시적 사전동의 증거. 광고 목적(purposeId)·동의받은 사업자(granteeBusinessId)가 이번 발신과 같아야 근거가 된다 */
  adConsent: { explicit: true; channel: 'phone'; evidenceId: string; purposeId: string; granteeBusinessId: string; at: Date; withdrawnAt: Date | null } | null;
  attempts: number;
  lastAttemptAt: Date | null;
};

export type DncStatus = { result: 'clear' | 'listed' | 'unknown' | 'error'; checkedAt: Date | null };
/** 내부 수신거부(동의철회) 조회 결과. 호출자가 boolean을 넘기지 않고 저장소 조회 결과를 넘긴다 */
export type SuppressionStatus = { result: 'clear' | 'blocked' | 'unknown' | 'error'; checkedAt: Date | null };

export type CallContext = {
  now: Date;
  mode: CallMode;
  dialer: Dialer;
  purposeId: string;                // 이번 발신의 광고 목적(불변 ID)
  businessId: string;               // 이번 발신 사업자(불변 ID)
  seller: { telemarketingRegistered: boolean | null; registrationNo: string | null };
  disclosure: { businessName: string; purpose: string; announcesSource: boolean };
  callerIdShown: boolean;
  businessNameShown: boolean;
  humanAgentReady: boolean | null;  // 발신 전: 사람 상담원이 배정되어 대기 중(응답 즉시 연결 가능). 확인 못 하면 null
  agentReserved: boolean | null;    // pds: 발신 전에 상담원이 예약됨(무응답 끊김 방지)
  dnc: DncStatus;
  suppression: SuppressionStatus;   // 내부 수신거부 저장소 조회 결과(발신 직전)
};

export type Reason =
  | 'NIGHT_BLOCKED' | 'OPTED_OUT' | 'FORBIDDEN_SOURCE' | 'SOURCE_UNVERIFIED' | 'NO_PRIOR_CONSENT' | 'CONSENT_WITHDRAWN'
  | 'NOT_REGISTERED' | 'DISCLOSURE_MISSING' | 'DNC_LISTED' | 'DNC_UNCONFIRMED' | 'AGENT_NOT_READY' | 'PDS_REQUIRES_AGENT'
  | 'CALLER_ID_REQUIRED' | 'RETRY_LIMIT' | 'RETRY_TOO_SOON' | 'SUPPRESSION_UNCONFIRMED' | 'CONSENT_SCOPE_MISMATCH' | 'INVALID_INPUT';

export type Decision = { allowed: boolean; basis: 'consent' | 'live_exception' | null; reasons: Reason[] };

const HMAC = /^[0-9a-f]{64}$/;
const kstHour = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).getUTCHours();
const nonEmpty = (s: unknown) => typeof s === 'string' && s.trim().length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
const dateOrNull = (d: unknown) => d === null || validDate(d);
const STATUS = (v: unknown, ok: readonly string[]) => isObj(v) && ok.includes(v.result as string) && dateOrNull(v.checkedAt);

export function withinCallingHours(now: Date): boolean {
  if (!validDate(now)) return false;
  const h = kstHour(now);
  return h >= OUTBOUND_RULES.startHourKst && h < OUTBOUND_RULES.endHourKst;
}

/** 런타임 형태 검사(타입을 믿지 않음). 하나라도 어긋나면 INVALID_INPUT(예외 없이 차단) */
function shapeOk(t: unknown, c: unknown): t is Target {
  if (!isObj(t) || !isObj(c)) return false;
  const src = t.source, con = t.adConsent;
  if (typeof t.phoneHmac !== 'string' || !HMAC.test(t.phoneHmac)) return false;
  if (!isObj(src) || typeof src.kind !== 'string' || typeof src.recordId !== 'string' || typeof src.lawfulVerified !== 'boolean' || typeof src.label !== 'string') return false;
  if (con !== null && !(isObj(con) && validDate(con.at) && dateOrNull(con.withdrawnAt))) return false;
  if (!Number.isInteger(t.attempts) || (t.attempts as number) < 0 || !dateOrNull(t.lastAttemptAt)) return false;
  if (!validDate(c.now) || (c.mode !== 'ars_ad' && c.mode !== 'live_agent') || (c.dialer !== 'manual' && c.dialer !== 'pds')) return false;
  if (typeof c.purposeId !== 'string' || typeof c.businessId !== 'string') return false;
  if (!isObj(c.seller) || !isObj(c.disclosure)) return false;
  if (typeof c.callerIdShown !== 'boolean' || typeof c.businessNameShown !== 'boolean') return false;
  if (!STATUS(c.dnc, ['clear', 'listed', 'unknown', 'error']) || !STATUS(c.suppression, ['clear', 'blocked', 'unknown', 'error'])) return false;
  return true;
}

/** 근거로 쓸 수 있는 동의: 명시·전화·증거 ID·철회 없음·동의 시각 ≤ 지금 + 목적·사업자 일치 */
function consentState(t: Target, ctx: CallContext): 'valid' | 'none' | 'withdrawn' | 'scope_mismatch' {
  const c = t.adConsent;
  if (!c) return 'none';
  if (c.withdrawnAt !== null) return 'withdrawn';
  if (c.explicit !== true || c.channel !== 'phone' || !nonEmpty(c.evidenceId) || !validDate(c.at) || c.at.getTime() > ctx.now.getTime()) return 'none';
  if (!nonEmpty(c.purposeId) || !nonEmpty(c.granteeBusinessId) || c.purposeId !== ctx.purposeId || c.granteeBusinessId !== ctx.businessId) return 'scope_mismatch';
  return 'valid';
}

function fresh(checkedAt: Date | null, now: Date, maxAge: number): boolean {
  if (!validDate(checkedAt)) return false;
  const age = now.getTime() - checkedAt.getTime();
  return age >= 0 && age <= maxAge;
}

/** 대상 1건 발신 판정. 모든 실패 사유를 모아 돌려준다(사유가 하나라도 있으면 차단). 예외를 던지지 않는다. */
export function decideOutbound(t: Target, ctx: CallContext): Decision {
  try {
    return decide(t, ctx);
  } catch {
    return { allowed: false, basis: null, reasons: ['INVALID_INPUT'] };
  }
}

function decide(t: Target, ctx: CallContext): Decision {
  if (!shapeOk(t, ctx)) return { allowed: false, basis: null, reasons: ['INVALID_INPUT'] };
  const r = new Set<Reason>();
  if (!withinCallingHours(ctx.now)) r.add('NIGHT_BLOCKED');
  if (!(ALLOWED_SOURCES as readonly string[]).includes(t.source.kind)) r.add('FORBIDDEN_SOURCE');
  if (t.source.lawfulVerified !== true || !nonEmpty(t.source.recordId) || !nonEmpty(t.source.label)) r.add('SOURCE_UNVERIFIED');
  if (!ctx.callerIdShown || !ctx.businessNameShown || !nonEmpty(ctx.disclosure.businessName)) r.add('CALLER_ID_REQUIRED');
  if (t.attempts >= OUTBOUND_RULES.maxAttemptsPerTarget) r.add('RETRY_LIMIT');
  if (t.lastAttemptAt && ctx.now.getTime() - t.lastAttemptAt.getTime() < OUTBOUND_RULES.minRetryIntervalMs) r.add('RETRY_TOO_SOON');
  // 내부 수신거부(정보통신망법 제50조 제2항): 저장소 조회 결과만 믿는다. 차단·미확인·오류·오래된 조회는 모두 차단
  if (ctx.suppression.result === 'blocked') r.add('OPTED_OUT');
  else if (ctx.suppression.result !== 'clear' || !fresh(ctx.suppression.checkedAt, ctx.now, OUTBOUND_RULES.suppressionMaxAgeMs)) r.add('SUPPRESSION_UNCONFIRMED');
  // 두낫콜(방문판매법 제42조): 동의 여부와 관계없이 최신 조회 '등록 안 됨'만 통과(엄격 운영)
  if (ctx.dnc.result === 'listed') r.add('DNC_LISTED');
  else if (ctx.dnc.result !== 'clear' || !fresh(ctx.dnc.checkedAt, ctx.now, OUTBOUND_RULES.dncMaxAgeMs)) r.add('DNC_UNCONFIRMED');
  if (ctx.dialer === 'pds' && (ctx.mode !== 'live_agent' || ctx.agentReserved !== true)) r.add('PDS_REQUIRES_AGENT');
  // 방문판매법 제5조: 전화권유판매업 신고가 원칙이다. 소규모 예외 등은 법률 자문으로 확정되기 전까지 열지 않는다.
  if (ctx.seller.telemarketingRegistered !== true || !nonEmpty(ctx.seller.registrationNo)) r.add('NOT_REGISTERED');

  const cs = consentState(t, ctx);
  if (cs === 'withdrawn') r.add('CONSENT_WITHDRAWN');
  if (cs === 'scope_mismatch') r.add('CONSENT_SCOPE_MISMATCH');
  let basis: Decision['basis'] = null;
  if (ctx.mode === 'ars_ad') {
    // 자동 음성 광고는 육성 예외가 없다 → 목적·사업자가 맞는 명시적 사전동의만
    if (cs !== 'valid') r.add('NO_PRIOR_CONSENT'); else basis = 'consent';
  } else if (cs === 'valid') {
    basis = 'consent';
    if (ctx.humanAgentReady !== true) r.add('AGENT_NOT_READY');
  } else {
    // 육성 전화권유 예외(정보통신망법 제50조 제1항 단서 + 방문판매법 제5조): 모두 확인돼야 함
    if (!nonEmpty(ctx.disclosure.purpose) || ctx.disclosure.announcesSource !== true || !nonEmpty(ctx.disclosure.businessName)) r.add('DISCLOSURE_MISSING');
    if (ctx.humanAgentReady !== true) r.add('AGENT_NOT_READY');
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
    if (!isObj(t) || typeof t.phoneHmac !== 'string' || seen.has(t.phoneHmac)) continue;
    seen.add(t.phoneHmac);
    let c: CallContext;
    try { c = ctxFor(t); } catch { continue; }
    if (decideOutbound(t, c).allowed) ok.push(t);
  }
  for (let i = ok.length - 1; i > 0; i--) {
    const j = Math.floor(Math.min(Math.max(rng(), 0), 0.999999999) * (i + 1));
    [ok[i], ok[j]] = [ok[j], ok[i]];
  }
  return ok;
}

/** 결정 감사 기록: 연락처 HMAC·사유·근거만(전화번호 원문·이름·고지 문구 없음) */
export type OutboundAudit = { at: string; phoneHmac: string; mode: CallMode; dialer: Dialer; allowed: boolean; basis: Decision['basis']; reasons: Reason[] };
export function auditRecord(t: Target, ctx: CallContext, d: Decision): OutboundAudit {
  return { at: validDate(ctx?.now) ? ctx.now.toISOString() : 'invalid', phoneHmac: typeof t?.phoneHmac === 'string' && HMAC.test(t.phoneHmac) ? t.phoneHmac : 'invalid', mode: ctx?.mode, dialer: ctx?.dialer, allowed: d.allowed, basis: d.basis, reasons: [...d.reasons] };
}
