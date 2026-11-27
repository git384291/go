// 가상 연습 데이터 — 총판 확인 집계 종단 시험용(PM 7043652741). **전부 가상이며 실제 접수·총판 확인이 아니다.** 실적으로 세지 않는다.
import type { AckRecord, HandoffRecord, LeadRecord } from '../content/dealerLedger';

const kst = (s: string) => Date.parse(`${s}+09:00`);
const lead = (n: number, customerKey = `c${n}`, consent = true): LeadRecord => ({ leadId: `L${n}`, customerKey, consentAt: consent ? kst('2026-11-22T09:00:00') : null, origin: 'MOCK' });
const ho = (n: number, dealer: 'dealer_a' | 'dealer_b' = 'dealer_a', at = '2026-11-22T10:00:00'): HandoffRecord => ({ leadId: `L${n}`, dealer, sentAt: kst(at) });
const ack = (e: string, n: number, at: string, dealer: 'dealer_a' | 'dealer_b' = 'dealer_a'): AckRecord => ({ eventId: e, leadId: `L${n}`, dealer, at: kst(at), evidence: 'dealer_ack_fixture' });

// 10건: L1 11/23 00:00:00.000 확인 / L2 11/22 23:59:59.999 확인 / L3 두 총판 모두 확인 / L4·L5 같은 고객 재접수(둘 다 확인) /
// L6 확인 이벤트 중복 / L7 동의 없음 / L8 인계 없는 총판의 확인 / L9 인계보다 이른 확인 / L10 인계만 하고 확인 없음
export const REHEARSAL_LEADS: readonly LeadRecord[] = [lead(1), lead(2), lead(3), lead(4, 'same'), lead(5, 'same'), lead(6), lead(7, 'c7', false), lead(8), lead(9), lead(10)];
export const REHEARSAL_HANDOFFS: readonly HandoffRecord[] = [ho(1), ho(2), ho(3, 'dealer_a'), ho(3, 'dealer_b'), ho(4), ho(5, 'dealer_b'), ho(6), ho(7), ho(8, 'dealer_a'), ho(9, 'dealer_a', '2026-11-22T12:00:00'), ho(10), ho(1)];
export const REHEARSAL_ACKS: readonly AckRecord[] = [
  ack('e1', 1, '2026-11-23T00:00:00.000'), ack('e2', 2, '2026-11-22T23:59:59.999'),
  ack('e3a', 3, '2026-11-22T15:00:00', 'dealer_a'), ack('e3b', 3, '2026-11-23T01:00:00', 'dealer_b'),
  ack('e4', 4, '2026-11-22T16:00:00'), ack('e5', 5, '2026-11-23T02:00:00', 'dealer_b'),
  ack('e6', 6, '2026-11-22T17:00:00'), ack('e6', 6, '2026-11-22T17:00:01'),
  ack('e7', 7, '2026-11-22T18:00:00'), ack('e8', 8, '2026-11-22T18:00:00', 'dealer_b'), ack('e9', 9, '2026-11-22T11:00:00'),
];
