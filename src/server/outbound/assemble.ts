/**
 * 광고성 전화 서버 조립(순수, 서버 전용 모듈 service.ts가 실제 DB 트랜잭션을 넣어 쓴다). 실제 발신·외부 API·스케줄러·번호 원문 입력 없음.
 * - 기본: 모든 것이 닫힌 Mock. OUTBOUND_PERSISTENCE=db일 때만 수신거부·원장을 DB 어댑터로 바꾼다(같은 사업자·같은 app_call 트랜잭션에 묶음).
 * - 두낫콜·발신기는 계속 Mock만(그 밖 선택은 LIVE_OUTBOUND_NOT_APPROVED). 🔴 DB가 연결돼도 live 발신은 금지.
 * - persistence=db인데 트랜잭션·사업자 ID가 없거나 0070 함수 6개를 실행할 수 없으면 발신 경로가 닫힌다(INVALID_INPUT, dial 0회).
 */
import type { CallContext, Target } from './compliance';
import { DbOutboundLedger, DbSuppressionStore, type OutboundTx } from './db';
import {
  ClosedMockDnc, ClosedMockLedger, ClosedMockSuppressionStore, OutboundError, placeOutboundCall, selectDncChecker, selectOutboundDialer,
  type OutboundDeps, type PlaceResult,
} from './providers';

type Env = Readonly<Record<string, string | undefined>>;
export type Persistence = 'mock' | 'db';
export type AssembleOptions = {
  businessId?: string;
  tx?: OutboundTx | null;
  clock?: () => Date;
  /** 시험 전용: 닫힌 Mock 두낫콜의 고정 결과표(외부 호출 없음). 두낫콜 모드가 mock일 때만 쓰인다 */
  mockDncTable?: Readonly<Record<string, 'clear' | 'listed' | 'error'>>;
};

const BUSINESS = /^[a-z0-9][a-z0-9_-]{1,39}$/;
export const OUTBOUND_DB_FUNCTIONS = [
  'api.outbound_suppression_block(text,text)', 'api.outbound_suppression_check(text,text)',
  'api.outbound_attempt_begin(text,text,text,text,text)', 'api.outbound_attempt_finish(text,bigint,text)',
  'api.outbound_attempt_status(text,text)', 'api.outbound_decision_record(text,text,boolean,text,text[])',
] as const;

export function persistenceMode(env: Env): Persistence {
  const m = env.OUTBOUND_PERSISTENCE ?? 'mock';
  if (m === 'mock' || m === 'db') return m;
  throw new OutboundError('INVALID_CONFIG');
}

/** 설정 → 의존성. 설정이 틀리면 예외(OutboundError) — 호출자는 이를 '닫힘'으로 처리한다 */
export function assembleOutbound(env: Env, opts: AssembleOptions = {}): { deps: OutboundDeps; persistence: Persistence } {
  const persistence = persistenceMode(env);
  const dncMode = env.OUTBOUND_DNC_MODE ?? 'mock';
  const dnc = dncMode === 'mock' && opts.mockDncTable ? new ClosedMockDnc(opts.mockDncTable) : selectDncChecker(env);
  const dialer = selectOutboundDialer(env);
  if (persistence === 'mock') {
    return { persistence, deps: { dnc, dialer, suppression: new ClosedMockSuppressionStore(), ledger: new ClosedMockLedger(), clock: opts.clock } };
  }
  if (typeof opts.tx !== 'function' || typeof opts.businessId !== 'string' || !BUSINESS.test(opts.businessId)) {
    throw new OutboundError('PERSISTENCE_NOT_CONFIGURED');
  }
  return {
    persistence,
    deps: { dnc, dialer, suppression: new DbSuppressionStore(opts.tx, opts.businessId), ledger: new DbOutboundLedger(opts.tx, opts.businessId), clock: opts.clock },
  };
}

/** 0070 함수 6개가 있고 현재 역할(app_call)이 실행할 수 있는지. 실패·형태 이상은 false */
export async function outboundDbReady(tx: OutboundTx): Promise<boolean> {
  try {
    const rows = await tx((sql) => sql`select count(*)::int as n from unnest(${[...OUTBOUND_DB_FUNCTIONS]}::text[]) f
                                         where to_regprocedure(f) is not null and has_function_privilege(to_regprocedure(f), 'execute')`);
    const r = Array.isArray(rows) ? rows[0] : null;
    return typeof r === 'object' && r !== null && Number((r as { n?: unknown }).n) === OUTBOUND_DB_FUNCTIONS.length;
  } catch {
    return false;
  }
}

export type OutboundService = {
  persistence: Persistence | 'closed';
  place(target: Target, base: Omit<CallContext, 'dnc' | 'suppression' | 'now'>): Promise<PlaceResult>;
};

/**
 * 서비스: 설정 오류·DB 준비 안 됨이면 모든 place가 닫힘(INVALID_INPUT, dial 0회). DB 준비 확인은 성공했을 때만 기억한다(실패는 매번 다시 확인).
 * 사업자 ID는 생성 때 고정되고, base.businessId가 다르면 거부한다.
 */
export function createOutboundService(env: Env, opts: AssembleOptions = {}): OutboundService {
  let assembled: ReturnType<typeof assembleOutbound> | null = null;
  try { assembled = assembleOutbound(env, opts); } catch { assembled = null; }
  let ready = assembled?.persistence === 'mock';
  const closed = (target: Target, base: Omit<CallContext, 'dnc' | 'suppression' | 'now'>) => placeOutboundCall(null as never, target, base);
  return {
    persistence: assembled ? assembled.persistence : 'closed',
    async place(target, base) {
      if (!assembled) return closed(target, base);
      if (assembled.persistence === 'db') {
        if (typeof base !== 'object' || base === null || base.businessId !== opts.businessId) return closed(target, base);
        if (!ready) ready = await outboundDbReady(opts.tx as OutboundTx);
        if (!ready) return closed(target, base);
      }
      return placeOutboundCall(assembled.deps, target, base);
    },
  };
}
