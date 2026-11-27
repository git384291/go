/**
 * 두낫콜(수신거부 등록시스템)·통신사 발신 연동 경계. 실제 연결·발신·계정·키·비용은 금지 — 닫힌 Mock만 있다(코사장 11/27).
 * live 선택은 LIVE_OUTBOUND_NOT_APPROVED로 거부한다. 녹취·문자변환은 기존 src/server/calls(ingest·recording·stt)를 쓰고 여기서 다시 만들지 않는다.
 */
import type { DncStatus } from './compliance';

export class OutboundError extends Error { constructor(readonly code: string) { super(code); } }

export interface DncChecker {
  readonly name: string;
  check(phoneHmac: string, now: Date): Promise<DncStatus>;
}

export interface OutboundDialer {
  readonly name: string;
  /** 발신 요청. 판정(decideOutbound) 통과 뒤에만 호출해야 한다. 반환: 업체 통화 ID */
  dial(req: { phoneHmac: string; callerId: string; businessName: string }): Promise<string>;
}

/** 시험용 두낫콜: 미리 정한 결과만 돌려준다(외부 호출 0). 정하지 않은 번호는 'unknown'(= 차단) */
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

/** 시험용 발신기: 실제로 전화를 걸지 않고 요청만 기록한다(비용 0) */
export class ClosedMockDialer implements OutboundDialer {
  readonly name = 'mock_dialer';
  readonly placed: { phoneHmac: string; callerId: string; businessName: string }[] = [];
  async dial(req: { phoneHmac: string; callerId: string; businessName: string }): Promise<string> {
    this.placed.push({ ...req });
    return `mock-${this.placed.length}`;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function selectDncChecker(env: Env = process.env): DncChecker {
  const m = env.OUTBOUND_DNC_MODE ?? 'mock';
  if (m === 'mock') return new ClosedMockDnc();
  throw new OutboundError('LIVE_OUTBOUND_NOT_APPROVED');
}

export function selectOutboundDialer(env: Env = process.env): OutboundDialer {
  const m = env.OUTBOUND_DIAL_MODE ?? 'mock';
  if (m === 'mock') return new ClosedMockDialer();
  throw new OutboundError('LIVE_OUTBOUND_NOT_APPROVED');
}
