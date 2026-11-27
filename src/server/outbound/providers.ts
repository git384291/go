/**
 * 두낫콜(수신거부 등록시스템)·내부 수신거부 저장소·통신사 발신 연동 경계. 실제 연결·발신·계정·키·비용은 금지 — 닫힌 Mock만 있다(코사장 11/27).
 * live 선택은 LIVE_OUTBOUND_NOT_APPROVED로 거부한다. 녹취·문자변환은 기존 src/server/calls(ingest·recording·stt)를 쓰고 여기서 다시 만들지 않는다.
 *
 * 발신 경계(설계 메모)
 * - ⚠ 위험: OutboundDialer.dial은 인터페이스라 누구든 직접 부를 수 있다. 그래서 dial 호출은 이 파일의 placeOutboundCall 한 곳에서만 한다
 *   (시험 OB-ORCH가 src 전체에서 `.dial(` 호출 위치를 검사). live 발신기를 만들 때도 이 경로만 쓴다.
 * - placeOutboundCall은 발신 직전에 두낫콜·내부 수신거부를 새로 조회해 판정(decideOutbound)에 넣고, 통과했을 때만 dial을 부른다.
 * - 내부 수신거부 저장소는 지금 프로세스 메모리 Mock이다 — 재시작하면 사라지므로 '영구'가 아니다. 지속 DB 저장은 별도 마이그레이션 PR 필요(미완료).
 */
import { auditRecord, decideOutbound, type CallContext, type Decision, type DncStatus, type OutboundAudit, type SuppressionStatus, type Target } from './compliance';

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

export interface OutboundDialer {
  readonly name: string;
  /** 직접 호출 금지 — placeOutboundCall만 부른다. 반환: 업체 통화 ID */
  dial(req: { phoneHmac: string; callerIdShown: true; businessName: string }): Promise<string>;
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
  readonly placed: { phoneHmac: string; businessName: string }[] = [];
  async dial(req: { phoneHmac: string; callerIdShown: true; businessName: string }): Promise<string> {
    this.placed.push({ phoneHmac: req.phoneHmac, businessName: req.businessName });
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

export type OutboundDeps = { dnc: DncChecker; suppression: SuppressionStore; dialer: OutboundDialer };
export type PlaceResult = { decision: Decision; callId: string | null; audit: OutboundAudit };

/**
 * 유일한 발신 경로. 발신 직전 두낫콜·내부 수신거부를 새로 조회 → 판정 → 통과 시에만 dial.
 * base의 dnc·suppression 값은 무시하고 조회 결과로 덮어쓴다(호출자가 'clear'를 넣어 우회하지 못하게). 조회 예외는 error로 바꿔 차단.
 */
export async function placeOutboundCall(deps: OutboundDeps, target: Target, base: Omit<CallContext, 'dnc' | 'suppression'>): Promise<PlaceResult> {
  const now = base.now;
  const dnc = await deps.dnc.check(target.phoneHmac, now).catch((): DncStatus => ({ result: 'error', checkedAt: null }));
  const suppression = await deps.suppression.check(target.phoneHmac, now).catch((): SuppressionStatus => ({ result: 'error', checkedAt: null }));
  const ctx: CallContext = { ...base, dnc, suppression };
  const decision = decideOutbound(target, ctx);
  const audit = auditRecord(target, ctx, decision);
  if (!decision.allowed) return { decision, callId: null, audit };
  const callId = await deps.dialer.dial({ phoneHmac: target.phoneHmac, callerIdShown: true, businessName: ctx.disclosure.businessName });
  return { decision, callId, audit };
}
