// 총판 확인 결과 집계 원장 — 순수 모듈 (PM 7043167591). 화면·API·저장소·시계·환경값에 연결하지 않았다.
// - 접수 1건이 "확인됨"으로 세어지려면: 동의 기록이 있고, 그 접수를 그 총판에 넘긴 기록(handoff)이 있고,
//   handoff 이후 시각의 총판 확인(ack)이 있어야 한다. 시스템 전송·수락만으로는 세지 않는다.
// - 모의(MOCK)와 실제(REAL)는 서로 다른 칸에 집계하고 합치지 않는다. 확인 근거는 모의가 dealer_ack_fixture, 실제가 dealer_record_ref뿐이다.
//   지금 실제 총판 확인 자료는 없으므로 운영에서 REAL은 0이다.
// - 중복: 같은 eventId의 ack는 한 번만, 같은 (접수,총판) handoff 재전송은 첫 기록만 둔다. 같은 고객키(customerKey)는 총판이 둘이어도,
//   접수가 여러 번이어도 한 명으로 센다(가장 이른 확인 기준).
// - 날짜: 한국시간(UTC+9) 0시 경계. 일자는 그 고객의 가장 이른 유효 확인 시각 기준이다.
export type Dealer = 'dealer_a' | 'dealer_b';
export type Origin = 'MOCK' | 'REAL';
export type Evidence = 'dealer_ack_fixture' | 'dealer_record_ref';

export type LeadRecord = { readonly leadId: string; readonly customerKey: string; readonly consentAt: number | null; readonly origin: Origin };
export type HandoffRecord = { readonly leadId: string; readonly dealer: Dealer; readonly sentAt: number };
export type AckRecord = { readonly eventId: string; readonly leadId: string; readonly dealer: Dealer; readonly at: number; readonly evidence: Evidence };

export type IgnoreReason = 'DUPLICATE_EVENT' | 'DUPLICATE_HANDOFF' | 'UNKNOWN_LEAD' | 'NO_HANDOFF' | 'ACK_BEFORE_HANDOFF' | 'EVIDENCE_MISMATCH' | 'INVALID';
export type UnconfirmedReason = 'NO_ACK' | 'NO_CONSENT' | 'ACK_REJECTED';
export type Counts = { readonly mock: number; readonly real: number };
export type Ledger = {
  readonly byDay: Readonly<Record<string, Counts>>;
  readonly total: Counts;
  readonly confirmed: readonly { readonly customerKey: string; readonly leadIds: readonly string[]; readonly dealers: readonly Dealer[]; readonly day: string; readonly origin: Origin }[];
  readonly unconfirmed: readonly { readonly leadId: string; readonly reason: UnconfirmedReason }[];
  readonly ignored: readonly { readonly reason: IgnoreReason; readonly eventId?: string; readonly leadId?: string }[];
};

const KST_MS = 9 * 3600 * 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isDealer = (v: unknown): v is Dealer => v === 'dealer_a' || v === 'dealer_b';

/** 한국시간 달력 날짜(YYYY-MM-DD) */
export function kstDay(at: number): string {
  return new Date(at + KST_MS).toISOString().slice(0, 10);
}

export function buildLedger(leads: readonly LeadRecord[], handoffs: readonly HandoffRecord[], acks: readonly AckRecord[]): Ledger {
  const ignored: { reason: IgnoreReason; eventId?: string; leadId?: string }[] = [];
  const L = new Map<string, LeadRecord>();
  for (const l of leads) {
    if (!l || !ID.test(l.leadId) || !ID.test(l.customerKey) || (l.consentAt !== null && !isTime(l.consentAt)) || (l.origin !== 'MOCK' && l.origin !== 'REAL')) { ignored.push({ reason: 'INVALID' }); continue; }
    if (!L.has(l.leadId)) L.set(l.leadId, l);
  }
  const H = new Map<string, HandoffRecord>();
  for (const h of handoffs) {
    if (!h || !ID.test(h.leadId) || !isDealer(h.dealer) || !isTime(h.sentAt)) { ignored.push({ reason: 'INVALID' }); continue; }
    if (!L.has(h.leadId)) { ignored.push({ reason: 'UNKNOWN_LEAD', leadId: h.leadId }); continue; }
    const k = `${h.leadId}|${h.dealer}`;
    if (H.has(k)) { ignored.push({ reason: 'DUPLICATE_HANDOFF', leadId: h.leadId }); continue; }
    H.set(k, h);
  }
  const seen = new Set<string>();
  const valid = new Map<string, AckRecord[]>(); // leadId → 유효 ack
  const rejected = new Set<string>();
  for (const a of acks) {
    if (!a || !ID.test(a.eventId) || !ID.test(a.leadId) || !isDealer(a.dealer) || !isTime(a.at)) { ignored.push({ reason: 'INVALID' }); continue; }
    if (seen.has(a.eventId)) { ignored.push({ reason: 'DUPLICATE_EVENT', eventId: a.eventId }); continue; }
    seen.add(a.eventId);
    const lead = L.get(a.leadId);
    if (!lead) { ignored.push({ reason: 'UNKNOWN_LEAD', eventId: a.eventId }); continue; }
    const h = H.get(`${a.leadId}|${a.dealer}`);
    const fail = (reason: IgnoreReason) => { ignored.push({ reason, eventId: a.eventId, leadId: a.leadId }); rejected.add(a.leadId); };
    if (!h) { fail('NO_HANDOFF'); continue; }
    if (a.at < h.sentAt) { fail('ACK_BEFORE_HANDOFF'); continue; }
    if ((lead.origin === 'MOCK') !== (a.evidence === 'dealer_ack_fixture') || (a.evidence !== 'dealer_ack_fixture' && a.evidence !== 'dealer_record_ref')) { fail('EVIDENCE_MISMATCH'); continue; }
    valid.set(a.leadId, [...(valid.get(a.leadId) ?? []), a]);
  }
  const unconfirmed: { leadId: string; reason: UnconfirmedReason }[] = [];
  const person = new Map<string, { customerKey: string; leadIds: string[]; dealers: Set<Dealer>; first: number; origin: Origin }>();
  for (const lead of L.values()) {
    const list = valid.get(lead.leadId);
    if (!list) { unconfirmed.push({ leadId: lead.leadId, reason: rejected.has(lead.leadId) ? 'ACK_REJECTED' : 'NO_ACK' }); continue; }
    if (lead.consentAt === null) { unconfirmed.push({ leadId: lead.leadId, reason: 'NO_CONSENT' }); continue; }
    const first = Math.min(...list.map((a) => a.at));
    const key = `${lead.origin}|${lead.customerKey}`; // 모의와 실제는 같은 고객키라도 합치지 않는다
    const p = person.get(key) ?? { customerKey: lead.customerKey, leadIds: [], dealers: new Set<Dealer>(), first, origin: lead.origin };
    p.leadIds.push(lead.leadId); list.forEach((a) => p.dealers.add(a.dealer)); p.first = Math.min(p.first, first);
    person.set(key, p);
  }
  const byDay: Record<string, { mock: number; real: number }> = {};
  const total = { mock: 0, real: 0 };
  const confirmed = [...person.values()].map((p) => {
    const day = kstDay(p.first);
    const c = (byDay[day] ??= { mock: 0, real: 0 });
    if (p.origin === 'MOCK') { c.mock += 1; total.mock += 1; } else { c.real += 1; total.real += 1; }
    return Object.freeze({ customerKey: p.customerKey, leadIds: Object.freeze(p.leadIds), dealers: Object.freeze([...p.dealers].sort()), day, origin: p.origin });
  }).sort((x, y) => x.day.localeCompare(y.day) || x.customerKey.localeCompare(y.customerKey));
  return Object.freeze({ byDay: Object.freeze(byDay), total: Object.freeze(total), confirmed: Object.freeze(confirmed), unconfirmed: Object.freeze(unconfirmed), ignored: Object.freeze(ignored) });
}
