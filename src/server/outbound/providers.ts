/**
 * 두낫콜(수신거부 등록시스템)·내부 수신거부 저장소·통신사 발신 연동 경계. 실제 연결·발신·계정·키·비용은 금지 — 닫힌 Mock만 있다(코사장 11/27).
 * live 선택은 LIVE_OUTBOUND_NOT_APPROVED로 거부한다. 녹취·문자변환은 기존 src/server/calls(ingest·recording·stt)를 쓰고 여기서 다시 만들지 않는다.
 *
 * 발신 경계(설계 메모)
 * - ⚠ 위험: OutboundDialer.dial은 인터페이스라 누구든 직접 부를 수 있다. 그래서 dial 호출은 이 파일의 placeOutboundCall 한 곳에서만 한다
 *   (시험 OB-ORCH가 src 전체에서 `.dial(` 호출 위치를 검사). live 발신기를 만들 때도 이 경로만 쓴다.
 * - placeOutboundCall은 발신 직전에 두낫콜·내부 수신거부를 새로 조회해 판정(decideOutbound)에 넣고, 통과했을 때만 dial을 부른다.
 * - 시각은 서버 신뢰 Clock만 쓴다(호출자가 now를 넘길 수 없음). 발신 직전 clock 값 하나를 판정·조회·감사에 똑같이 쓴다.
 * - placeOutboundCall은 예외를 던지지 않는다: 형태 불량·의존성 오류(동기/비동기 throw 포함)는 차단 결과로 돌려준다.
 * - 원장(ledger) 순서: 앱 판정 차단 → 차단 판정 기록 후 끝. 앱 판정 허용 → ① 시도 시작(DB가 3회·24시간·수신거부 확인) → 거부면 정확한 사유의
 *   차단 판정 기록 후 끝 → ② 수신거부 재조회(blocked·error·unknown이면 시도 취소·차단 판정 기록) → ③ 허용 판정 기록 성공 시에만 dial.
 *   어느 기록이든 실패하면 발신 0회. 발신 뒤 결과 기록 실패는 LEDGER_FINISH_FAILED로 알린다.
 * - ⚠ 남은 경쟁 위험: ②와 실제 통신망 연결 사이의 짧은 틈은 원자적으로 막을 수 없다(외부 통신망). 그래서 live 발신기는 계속 금지하고,
 *   live 구현 시 업체 쪽 발신 직전 차단 목록 확인(가능한 경우)과 통화 시작 직후 수신거부 처리 절차를 별도 검토한다.
 * - dial 계약: mode='live_agent'면 자동 음성 재생 금지, 수신자가 받으면 배정된 사람 상담원에게만 연결하고 상담원이 없으면 아무 말 없이 즉시 종료.
 *   mode='ars_ad'는 판정에서 목적·사업자 일치 명시 동의가 확인된 경우에만 온다. live 발신기는 여전히 금지(LIVE_OUTBOUND_NOT_APPROVED).
 * - 내부 수신거부 저장소는 지금 프로세스 메모리 Mock이다 — 재시작하면 사라지므로 '영구'가 아니다. 지속 DB 저장은 별도 마이그레이션 PR 필요(미완료).
 */
import { auditRecord, decideOutbound, type CallContext, type Decision, type DncStatus, type OutboundAudit, type Reason, type SuppressionStatus, type Target } from './compliance';

export class OutboundError extends Error { constructor(readonly code: string) { super(code); } }

export interface DncChecker {
  readonly name: string;
  check(phoneHmac: string, now: Date): Promise<DncStatus>;
}

export interface SuppressionStore {
  readonly name: string;
  readonly persistent: boolean;
  check(phoneHmac: string, now: Date): Promise<SuppressionStatus>;
  /** 수신거부·동의철회 기록(즉시). 해제 기능은 두지 않는다 */
  block(phoneHmac: string, now: Date): Promise<void>;
}

export type DialRequest = { phoneHmac: string; mode: 'live_agent' | 'ars_ad'; callerIdShown: true; businessName: string };

export interface OutboundDialer {
  readonly name: string;
  /** 직접 호출 금지 — placeOutboundCall만 부른다. 계약은 파일 머리말(live_agent: 자동음성 금지·사람 상담원만 연결). 반환: 업체 통화 ID */
  dial(req: DialRequest): Promise<string>;
}

/**
 * 판정·시도 기록(원장). 계약: recordDecision이 실패하면 발신하지 않는다. beginAttempt는 저장소가 누적 3회·24시간·수신거부를 직접 확인하고
 * 통과 시 시도 ID를 돌려준다(거부는 OutboundError(사유 코드)). 원문 번호·이름·고지문은 넘기지 않는다(HMAC·코드만).
 */
export type DecisionEntry = { businessId: string; phoneHmac: string; allowed: boolean; basis: Decision['basis']; reasons: readonly string[] };
export type AttemptEntry = { businessId: string; phoneHmac: string; purposeId: string; mode: 'live_agent' | 'ars_ad'; dialer: 'manual' | 'pds' };
export type AttemptResult = 'placed' | 'dial_failed' | 'cancelled';
export interface OutboundLedger {
  readonly name: string;
  recordDecision(e: DecisionEntry): Promise<void>;
  beginAttempt(e: AttemptEntry): Promise<number>;
  finishAttempt(attemptId: number, result: AttemptResult): Promise<void>;
}

/** 시험용 원장: 메모리(지속 아님). fail로 단계별 실패 주입 */
export class ClosedMockLedger implements OutboundLedger {
  readonly name = 'mock_ledger';
  readonly decisions: DecisionEntry[] = [];
  readonly attempts: (AttemptEntry & { id: number; result: string | null })[] = [];
  constructor(private readonly fail: { decision?: boolean; begin?: string; finish?: boolean } = {}) {}
  async recordDecision(e: DecisionEntry): Promise<void> {
    if (this.fail.decision) throw new OutboundError('LEDGER_FAILED');
    this.decisions.push({ ...e, reasons: [...e.reasons] });
  }
  async beginAttempt(e: AttemptEntry): Promise<number> {
    if (this.fail.begin) throw new OutboundError(this.fail.begin);
    const id = this.attempts.length + 1;
    this.attempts.push({ ...e, id, result: null });
    return id;
  }
  async finishAttempt(attemptId: number, result: AttemptResult): Promise<void> {
    if (this.fail.finish) throw new OutboundError('LEDGER_FAILED');
    const a = this.attempts.find((x) => x.id === attemptId);
    if (!a || a.result !== null) throw new OutboundError('ALREADY_RECORDED');
    a.result = result;
  }
}

/** 시험용 두낫콜: 미리 정한 결과만(외부 호출 0). 정하지 않은 번호는 'unknown'(= 차단) */
export class ClosedMockDnc implements DncChecker {
  readonly name = 'mock_dnc';
  calls = 0;
  constructor(private readonly table: Readonly<Record<string, 'clear' | 'listed' | 'error'>> = {}) {}
  async check(phoneHmac: string, now: Date): Promise<DncStatus> {
    this.calls += 1;
    const v = this.table[phoneHmac];
    if (v === 'clear' || v === 'listed') return { result: v, checkedAt: now };
    return { result: v === 'error' ? 'error' : 'unknown', checkedAt: null };
  }
}

/** 시험용 내부 수신거부: 프로세스 메모리(지속 아님, persistent=false). 실패 주입 가능 */
export class ClosedMockSuppressionStore implements SuppressionStore {
  readonly name = 'mock_suppression';
  readonly persistent = false;
  private readonly s = new Map<string, Date>();
  constructor(private readonly failing = false) {}
  async check(phoneHmac: string, now: Date): Promise<SuppressionStatus> {
    if (this.failing) return { result: 'error', checkedAt: null };
    if (!/^[0-9a-f]{64}$/.test(phoneHmac)) return { result: 'unknown', checkedAt: null };
    return { result: this.s.has(phoneHmac) ? 'blocked' : 'clear', checkedAt: now };
  }
  async block(phoneHmac: string, now: Date): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(phoneHmac)) throw new OutboundError('INVALID_INPUT');
    if (!this.s.has(phoneHmac)) this.s.set(phoneHmac, now);
  }
}

/** 시험용 발신기: 실제로 걸지 않고 요청만 기록(비용 0) */
export class ClosedMockDialer implements OutboundDialer {
  readonly name = 'mock_dialer';
  readonly placed: { phoneHmac: string; mode: DialRequest['mode']; businessName: string }[] = [];
  async dial(req: DialRequest): Promise<string> {
    this.placed.push({ phoneHmac: req.phoneHmac, mode: req.mode, businessName: req.businessName });
    return `mock-${this.placed.length}`;
  }
}

type Env = Readonly<Record<string, string | undefined>>;
const closed = (): never => { throw new OutboundError('LIVE_OUTBOUND_NOT_APPROVED'); };

export function selectDncChecker(env: Env = process.env): DncChecker {
  return (env.OUTBOUND_DNC_MODE ?? 'mock') === 'mock' ? new ClosedMockDnc() : closed();
}
export function selectSuppressionStore(env: Env = process.env): SuppressionStore {
  return (env.OUTBOUND_SUPPRESSION_MODE ?? 'mock') === 'mock' ? new ClosedMockSuppressionStore() : closed();
}
export function selectOutboundDialer(env: Env = process.env): OutboundDialer {
  return (env.OUTBOUND_DIAL_MODE ?? 'mock') === 'mock' ? new ClosedMockDialer() : closed();
}

export type OutboundDeps = { dnc: DncChecker; suppression: SuppressionStore; dialer: OutboundDialer; ledger: OutboundLedger; clock?: () => Date };
export type PlaceError = 'DIAL_FAILED' | 'LEDGER_FAILED' | 'ATTEMPT_REJECTED' | 'LEDGER_FINISH_FAILED';
export type PlaceResult = { decision: Decision; callId: string | null; audit: OutboundAudit; error: PlaceError | null };
export type BaseContext = Omit<CallContext, 'dnc' | 'suppression' | 'now'>;

const INVALID: Decision = { allowed: false, basis: null, reasons: ['INVALID_INPUT'] };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** 동기 throw까지 잡는 조회: Promise.resolve().then으로 감싸 어떤 오류도 fallback으로 바꾼다 */
const safely = <T>(f: () => Promise<T> | T, fallback: T): Promise<T> => Promise.resolve().then(f).catch(() => fallback);

/**
 * 유일한 발신 경로. 서버 Clock으로 발신 시각을 정하고, 그 시각에 두낫콜·내부 수신거부를 새로 조회 → 판정 → 통과 시에만 dial.
 * base에 now·dnc·suppression이 들어 있어도 무시한다(위조 시각·위조 조회 결과로 우회 불가). 예외를 던지지 않는다.
 */
export async function placeOutboundCall(deps: OutboundDeps, target: Target, base: BaseContext): Promise<PlaceResult> {
  let now: Date;
  try {
    now = (isObj(deps) && typeof deps.clock === 'function' ? deps.clock : () => new Date())();
  } catch {
    now = new Date(NaN);
  }
  const blocked = (decision: Decision, ctx?: CallContext): PlaceResult =>
    ({ decision, callId: null, audit: auditRecord(target, ctx ?? ({ now, mode: (base as BaseContext)?.mode, dialer: (base as BaseContext)?.dialer } as CallContext), decision), error: null });
  try {
    if (!isObj(deps) || !isObj(deps.dnc) || !isObj(deps.suppression) || !isObj(deps.dialer)
      || typeof deps.dnc.check !== 'function' || typeof deps.suppression.check !== 'function' || typeof deps.dialer.dial !== 'function'
      || !isObj(deps.ledger) || typeof deps.ledger.recordDecision !== 'function' || typeof deps.ledger.beginAttempt !== 'function' || typeof deps.ledger.finishAttempt !== 'function'
      || !isObj(target) || typeof target.phoneHmac !== 'string' || !/^[0-9a-f]{64}$/.test(target.phoneHmac) || !isObj(base)
      || !(now instanceof Date) || Number.isNaN(now.getTime())) {
      return blocked(INVALID);
    }
    const h = target.phoneHmac;
    const dnc = await safely<DncStatus>(() => deps.dnc.check(h, now), { result: 'error', checkedAt: null });
    const suppression = await safely<SuppressionStatus>(() => deps.suppression.check(h, now), { result: 'error', checkedAt: null });
    const { now: _ignoredNow, dnc: _ignoredDnc, suppression: _ignoredSup, ...rest } = base as BaseContext & Partial<Pick<CallContext, 'now' | 'dnc' | 'suppression'>>;
    void _ignoredNow; void _ignoredDnc; void _ignoredSup;
    const ctx: CallContext = { ...(rest as BaseContext), now, dnc, suppression };
    const decision = decideOutbound(target, ctx);
    const record = (d: Decision) => safely(async () => {
      await deps.ledger.recordDecision({ businessId: ctx.businessId, phoneHmac: h, allowed: d.allowed, basis: d.basis, reasons: d.reasons });
      return true;
    }, false);
    const deny = async (reason: Reason, error: PlaceError | null, attemptToCancel: number | null): Promise<PlaceResult> => {
      const d: Decision = { allowed: false, basis: null, reasons: [reason] };
      if (attemptToCancel !== null) await safely(() => deps.ledger.finishAttempt(attemptToCancel, 'cancelled'), undefined);
      const ok = await record(d);
      return { decision: d, callId: null, audit: auditRecord(target, ctx, d), error: ok ? error : 'LEDGER_FAILED' };
    };
    // 앱 판정 차단: 차단 판정만 기록하고 끝(기록 실패도 발신 0회)
    if (!decision.allowed) {
      const ok = await record(decision);
      return { decision, callId: null, audit: auditRecord(target, ctx, decision), error: ok ? null : 'LEDGER_FAILED' };
    }
    // ① 시도 시작: 저장소가 3회·24시간·수신거부를 다시 확인(호출자 숫자 불신)
    let attemptId: number | null = null;
    let rejectCode: string | null = null;
    await Promise.resolve().then(() => deps.ledger.beginAttempt({ businessId: ctx.businessId, phoneHmac: h, purposeId: ctx.purposeId, mode: ctx.mode, dialer: ctx.dialer }))
      .then((id) => { attemptId = Number.isSafeInteger(id) && id > 0 ? id : null; }, (e: unknown) => { rejectCode = e instanceof OutboundError ? e.code : 'LEDGER_FAILED'; });
    if (attemptId === null) {
      const code = rejectCode as string | null;
      if (code === 'RETRY_LIMIT' || code === 'RETRY_TOO_SOON' || code === 'OPTED_OUT') return deny(code, 'ATTEMPT_REJECTED', null);
      return deny('ATTEMPT_UNAVAILABLE', 'LEDGER_FAILED', null);
    }
    const id: number = attemptId;
    // ② 발신 직전 수신거부 재조회(시도 시작 뒤 끼어든 수신거부 차단)
    const again = await safely<SuppressionStatus>(() => deps.suppression.check(h, now), { result: 'error', checkedAt: null });
    if (!isObj(again) || again.result !== 'clear') return deny(isObj(again) && again.result === 'blocked' ? 'OPTED_OUT' : 'SUPPRESSION_UNCONFIRMED', null, id);
    // ③ 허용 판정 기록 성공 시에만 발신
    if (!(await record(decision))) {
      await safely(() => deps.ledger.finishAttempt(id, 'cancelled'), undefined);
      return { decision, callId: null, audit: auditRecord(target, ctx, decision), error: 'LEDGER_FAILED' };
    }
    const audit = auditRecord(target, ctx, decision);
    const callId = await safely<string | null>(() => deps.dialer.dial({ phoneHmac: h, mode: ctx.mode, callerIdShown: true, businessName: ctx.disclosure.businessName }), null);
    const finished = await safely(async () => { await deps.ledger.finishAttempt(id, callId === null ? 'dial_failed' : 'placed'); return true; }, false);
    return { decision, callId, audit, error: callId === null ? 'DIAL_FAILED' : finished ? null : 'LEDGER_FINISH_FAILED' };
  } catch {
    return blocked(INVALID);
  }
}
