/**
 * 광고성 전화 수신거부·판정·시도 기록의 DB 어댑터(0070). 실행 역할은 통화 작업자(app_call) — 연결은 호출자가 주는 트랜잭션 실행기로만.
 * - 조회 실패·형태 불량은 절대 clear로 보지 않는다(error로 돌려 판정에서 차단).
 * - 원문 번호·이름·고지문은 보내지 않는다(사업자 ID·HMAC·코드만). 값은 바인딩으로만 전달.
 * - 🟡 아직 실제 선택 경로(selectSuppressionStore 등)에 연결하지 않았다 — 선택 함수는 여전히 Mock만. 운영 연결은 법률 자문·신고·두낫콜 커넥터 뒤 별도 승인.
 */
import type { SuppressionStatus } from './compliance';
import { OutboundError, type AttemptEntry, type AttemptResult, type DecisionEntry, type OutboundLedger, type SuppressionStore } from './providers';

export type OutboundSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<readonly unknown[]>;
export type OutboundTx = <T>(fn: (sql: OutboundSql) => Promise<T>) => Promise<T>;

const BUSINESS = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const HMAC = /^[0-9a-f]{64}$/;
const DB_REASONS = new Set(['RETRY_LIMIT', 'RETRY_TOO_SOON', 'OPTED_OUT']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asDate = (v: unknown): Date | null => {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const ERR: SuppressionStatus = { result: 'error', checkedAt: null };

export class DbSuppressionStore implements SuppressionStore {
  readonly name = 'db_suppression';
  readonly persistent = true;
  constructor(private readonly tx: OutboundTx, private readonly businessId: string) {
    if (!BUSINESS.test(businessId)) throw new OutboundError('INVALID_INPUT');
  }
  /**
   * 조회는 매번 DB에서 실시간으로 한다. DB가 돌려준 checked_at은 형태만 검사하고, 신선도 판정용 시각은 이 조회를 실행한
   * 서버 신뢰 Clock 값(now)을 쓴다(판정·감사와 같은 시계 — DB 시계와 앱 시계 차이로 판정이 흔들리지 않게).
   */
  async check(phoneHmac: string, now: Date): Promise<SuppressionStatus> {
    if (typeof phoneHmac !== 'string' || !HMAC.test(phoneHmac) || !(now instanceof Date) || Number.isNaN(now.getTime())) return { result: 'unknown', checkedAt: null };
    try {
      const rows = await this.tx((sql) => sql`select result, checked_at from api.outbound_suppression_check(${this.businessId}, ${phoneHmac})`);
      if (!Array.isArray(rows) || rows.length !== 1 || !isObj(rows[0])) return ERR;
      const r = rows[0];
      const at = asDate(r.checked_at);
      if ((r.result !== 'clear' && r.result !== 'blocked') || !at) return ERR;
      return { result: r.result, checkedAt: now };
    } catch {
      return ERR;
    }
  }
  async block(phoneHmac: string): Promise<void> {
    if (typeof phoneHmac !== 'string' || !HMAC.test(phoneHmac)) throw new OutboundError('INVALID_INPUT');
    let rows: readonly unknown[];
    try {
      rows = await this.tx((sql) => sql`select api.outbound_suppression_block(${this.businessId}, ${phoneHmac}) as r`);
    } catch {
      throw new OutboundError('LEDGER_FAILED');
    }
    if (!Array.isArray(rows) || !isObj(rows[0]) || rows[0].r !== 'blocked') throw new OutboundError('LEDGER_FAILED');
  }
}

export class DbOutboundLedger implements OutboundLedger {
  readonly name = 'db_ledger';
  /** 사업자 ID를 생성 때 고정한다. 다른 사업자 ID로 온 기록·시도는 거부(INVALID_INPUT) */
  constructor(private readonly tx: OutboundTx, private readonly businessId: string) {
    if (!BUSINESS.test(businessId)) throw new OutboundError('INVALID_INPUT');
  }

  async recordDecision(e: DecisionEntry): Promise<void> {
    if (!isObj(e) || e.businessId !== this.businessId || !HMAC.test(e.phoneHmac) || typeof e.allowed !== 'boolean' || !Array.isArray(e.reasons)) throw new OutboundError('INVALID_INPUT');
    let rows: readonly unknown[];
    try {
      rows = await this.tx((sql) => sql`select api.outbound_decision_record(${e.businessId}, ${e.phoneHmac}, ${e.allowed}, ${e.basis}, ${[...e.reasons]}::text[]) as id`);
    } catch {
      throw new OutboundError('LEDGER_FAILED');
    }
    if (!Array.isArray(rows) || !isObj(rows[0]) || !(Number(rows[0].id) > 0)) throw new OutboundError('LEDGER_FAILED');
  }

  async beginAttempt(e: AttemptEntry): Promise<number> {
    if (!isObj(e) || e.businessId !== this.businessId || !HMAC.test(e.phoneHmac) || !BUSINESS.test(e.purposeId)) throw new OutboundError('INVALID_INPUT');
    let rows: readonly unknown[];
    try {
      rows = await this.tx((sql) => sql`select api.outbound_attempt_begin(${e.businessId}, ${e.phoneHmac}, ${e.purposeId}, ${e.mode}, ${e.dialer}) as id`);
    } catch (err) {
      const x = (err ?? {}) as { code?: unknown; message?: unknown };
      const m = typeof x.message === 'string' ? x.message.trim() : '';
      throw new OutboundError(x.code === '22023' && DB_REASONS.has(m) ? m : 'LEDGER_FAILED');
    }
    const id = Array.isArray(rows) && isObj(rows[0]) ? Number(rows[0].id) : NaN;
    if (!Number.isSafeInteger(id) || id < 1) throw new OutboundError('LEDGER_FAILED');
    return id;
  }

  async finishAttempt(attemptId: number, result: AttemptResult): Promise<void> {
    if (!Number.isSafeInteger(attemptId) || attemptId < 1 || (result !== 'placed' && result !== 'dial_failed' && result !== 'cancelled')) throw new OutboundError('INVALID_INPUT');
    try {
      await this.tx((sql) => sql`select api.outbound_attempt_finish(${this.businessId}, ${attemptId}::bigint, ${result})`);
    } catch {
      throw new OutboundError('LEDGER_FAILED');
    }
  }
}
