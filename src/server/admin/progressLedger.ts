import 'server-only';
// 진행판 스냅샷에 총판 확인 원장 연결 (PM 7043652741). 실적은 실제(REAL) 총판 확인 자료가 입력에 있을 때만 숫자이고, 없으면 '미확인'이다.
// 가상 연습(MOCK) 집계는 별도 칸으로만 싣고 실적에 합치지 않는다. 실제 총판 확인 자료 입력은 아직 없다(빈 입력).
import { buildLedger, type AckRecord, type HandoffRecord, type LeadRecord } from '../../content/dealerLedger';
import { rehearsalFromLedger, salesFromLedger, type ProgressSnapshot } from '../../content/progress';
import { REHEARSAL_ACKS, REHEARSAL_HANDOFFS, REHEARSAL_LEADS } from '../../mock/dealerRehearsal';
import { PROGRESS_SNAPSHOT } from './progressSnapshot';

export type DealerInput = { readonly leads: readonly LeadRecord[]; readonly handoffs: readonly HandoffRecord[]; readonly acks: readonly AckRecord[] };
/** 실제 총판 확인 자료: 아직 없음 */
export const REAL_DEALER_INPUT: DealerInput = Object.freeze({ leads: Object.freeze([]), handoffs: Object.freeze([]), acks: Object.freeze([]) });
export const REHEARSAL_INPUT: DealerInput = Object.freeze({ leads: REHEARSAL_LEADS, handoffs: REHEARSAL_HANDOFFS, acks: REHEARSAL_ACKS });

export function composeProgressSnapshot(base: ProgressSnapshot, real: DealerInput, rehearsal: DealerInput | null): ProgressSnapshot {
  const realLedger = buildLedger(real.leads, real.handoffs, real.acks);
  const out: ProgressSnapshot = { ...base, sales: salesFromLedger(real.leads, realLedger) };
  if (!rehearsal) return Object.freeze(out);
  return Object.freeze({ ...out, rehearsal: rehearsalFromLedger(buildLedger(rehearsal.leads, rehearsal.handoffs, rehearsal.acks)) });
}

export function loadProgressSnapshot(): ProgressSnapshot {
  return composeProgressSnapshot(PROGRESS_SNAPSHOT, REAL_DEALER_INPUT, REHEARSAL_INPUT);
}
