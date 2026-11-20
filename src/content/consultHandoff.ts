// 상담원 연결 결과 판정(순수 모듈, 미연결). PM 7026277296, 기준: 제안 7010893389 + 정정 7011431185.
// - 이 모듈은 화면·route·SDK·웹훅·저장소·시계·난수·환경값에 연결되어 있지 않다. 가상 요청·이벤트 식별자와 고정 상태만 다룬다.
// - 기본은 꺼짐(HANDOFF_ENABLED=false). 켜는 것은 별도 결정이다.
// - 시스템의 요청 수락·담당자 배정·상담방 생성은 "사람이 열람했다"는 증거가 아니다. 사람의 확인은 같은 요청에 대한
//   명시적 사람 확인 fixture(human_ack_fixture)로만 인정하고, 이는 모의 확인이다. 실제 업체의 확인 신호는 아직 확인되지 않았다.
// - 서비스의 '부재중' 표시는 서비스가 표시한 상태값일 뿐이며 사람의 실제 위치를 말하지 않는다. 고객 문구도 위치를 단정하지 않는다.
// - 고객 안내는 요청마다 한 번만 나가고, 한 번 정해진 결과는 늦게 온 신호·중복·다른 요청 신호로 바뀌지 않는다(늦은 신호는 기록만).
// 모든 함수는 입력을 바꾸지 않고 새 기록을 돌려준다.

/** 기본값: 꺼짐. 켜려면 실제 연결·고객정보 처리·비용 결정과 PM 검수가 먼저다 */
export const HANDOFF_ENABLED: boolean = false;

export type HandoffState = 'off' | 'connection_unavailable' | 'delivery_unknown' | 'mock_staff_confirmed';

/** 들어오는 신호 종류. 사람의 열람을 증명하는 것은 human_ack_fixture 하나뿐이다(모의) */
export type SignalKind =
  | 'request_accepted' // 서비스가 요청을 받았다
  | 'agent_assigned' // 담당자(배정 대상)가 정해졌다
  | 'room_created' // 상담방이 만들어졌다
  | 'agent_status_away' // 서비스가 담당자 상태를 '부재중'으로 표시했다(사람의 실제 위치가 아님)
  | 'agent_status_online' // 서비스가 담당자 상태를 '온라인'으로 표시했다(사람의 열람이 아님)
  | 'delivery_error' // 전달 오류·시간 초과 알림
  | 'human_ack_fixture'; // 같은 요청에 대한 명시적인 사람 확인(시험용 가상 이벤트)

export type Signal = { readonly eventId: string; readonly requestId: string; readonly kind: SignalKind; readonly at: number };

export type Decision = {
  readonly state: HandoffState;
  readonly at: number;
  /** 모의 확인만 true. 실제 업체 확인 신호는 미확인이라 항상 false */
  readonly mock: boolean;
  readonly real: false;
};

export type LateReason = 'duplicate' | 'other_request' | 'stale' | 'invalid' | 'after_decision';
export type LateEntry = { readonly eventId: string; readonly kind: string; readonly reason: LateReason };

export type HandoffRecord = {
  readonly requestId: string;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly seenEventIds: readonly string[];
  /** 관찰만 한 시스템 신호(사람의 열람 증거 아님) */
  readonly observed: { readonly accepted: boolean; readonly assigned: boolean; readonly roomCreated: boolean; readonly away: boolean; readonly online: boolean };
  readonly decision: Decision | null;
  /** 고객 안내를 이미 냈는지 */
  readonly replied: boolean;
  readonly ignored: readonly LateEntry[];
};

export const REPLIES: Readonly<Record<HandoffState, string>> = {
  off: '설치비는 상품과 설치 조건에 따라 달라요. 토요일 설치 가능 여부는 지금 확인해 드릴 수 없어요. 금액이나 일정을 확정해 드릴 수 없어요.',
  connection_unavailable: '현재 담당자 연결을 확인할 수 없어요. 이 문의가 전달됐다고 말씀드릴 수는 없어요. 금액이나 일정은 확정해 드릴 수 없어요.',
  delivery_unknown: '담당자에게 전달됐는지 확인하지 못했어요. 금액이나 일정은 확정해 드릴 수 없어요.',
  mock_staff_confirmed: '담당자가 이 문의를 확인했어요. 금액과 일정은 담당자가 안내해요.',
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS: readonly SignalKind[] = ['request_accepted', 'agent_assigned', 'room_created', 'agent_status_away', 'agent_status_online', 'delivery_error', 'human_ack_fixture'];
const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export type StartInput = { readonly requestId: string; readonly startedAt: number; readonly deadlineMs: number; readonly enabled?: boolean };

/** 요청 하나의 기록을 시작한다. 꺼짐(기본)이면 곧바로 '꺼짐'으로 정해진다 */
export function startHandoff(input: StartInput): HandoffRecord {
  if (!ID_RE.test(input.requestId)) throw new TypeError('requestId 형식 오류');
  if (!isTime(input.startedAt)) throw new TypeError('startedAt 형식 오류');
  if (!isTime(input.deadlineMs) || input.deadlineMs <= 0) throw new TypeError('deadlineMs는 0보다 커야 해요');
  const enabled = input.enabled ?? HANDOFF_ENABLED;
  const base: HandoffRecord = {
    requestId: input.requestId,
    startedAt: input.startedAt,
    deadlineAt: input.startedAt + input.deadlineMs,
    seenEventIds: [],
    observed: { accepted: false, assigned: false, roomCreated: false, away: false, online: false },
    decision: null,
    replied: false,
    ignored: [],
  };
  return enabled ? base : { ...base, decision: { state: 'off', at: input.startedAt, mock: false, real: false } };
}

const decide = (rec: HandoffRecord, state: HandoffState, at: number): HandoffRecord => ({ ...rec, decision: { state, at, mock: state === 'mock_staff_confirmed', real: false } });
const ignore = (rec: HandoffRecord, s: Signal, reason: LateReason): HandoffRecord => ({ ...rec, ignored: [...rec.ignored, { eventId: String(s.eventId), kind: String(s.kind), reason }] });

/** 시간 제한에 도달했으면 결과를 정한다: 부재중 표시를 봤으면 '연결 확인 불가', 아니면 '전달 결과 불명' */
export function settleDeadline(rec: HandoffRecord, now: number): HandoffRecord {
  if (rec.decision || !isTime(now) || now < rec.deadlineAt) return rec;
  return decide(rec, rec.observed.away ? 'connection_unavailable' : 'delivery_unknown', rec.deadlineAt);
}

/** 신호 하나를 반영한다. 이미 정해진 결과·이미 낸 안내는 바뀌지 않는다 */
export function applySignal(input: HandoffRecord, signal: Signal): HandoffRecord {
  if (!signal || !ID_RE.test(String(signal.eventId)) || !ID_RE.test(String(signal.requestId)) || !KINDS.includes(signal.kind) || !isTime(signal.at)) {
    return { ...input, ignored: [...input.ignored, { eventId: String(signal?.eventId ?? ''), kind: String(signal?.kind ?? ''), reason: 'invalid' }] };
  }
  if (input.seenEventIds.includes(signal.eventId)) return ignore(input, signal, 'duplicate');
  // 다른 요청의 신호는 이 요청의 시간·결과에 아무 영향을 주지 않는다
  if (signal.requestId !== input.requestId) return ignore(input, signal, 'other_request');
  // 신호 시각이 시간 제한 이후면, 이 신호를 반영하기 전에 시간 초과 결과를 먼저 정한다(늦게 온 신호가 결과를 뒤집지 못한다)
  let rec = settleDeadline(input, signal.at);
  rec = { ...rec, seenEventIds: [...rec.seenEventIds, signal.eventId] };
  if (rec.decision) return ignore(rec, signal, 'after_decision');
  if (signal.at < rec.startedAt) return ignore(rec, signal, 'stale');
  switch (signal.kind) {
    case 'human_ack_fixture':
      return decide(rec, 'mock_staff_confirmed', signal.at);
    case 'delivery_error':
      return decide(rec, 'delivery_unknown', signal.at);
    case 'request_accepted':
      return { ...rec, observed: { ...rec.observed, accepted: true } };
    case 'agent_assigned':
      return { ...rec, observed: { ...rec.observed, assigned: true } };
    case 'room_created':
      return { ...rec, observed: { ...rec.observed, roomCreated: true } };
    case 'agent_status_away':
      return { ...rec, observed: { ...rec.observed, away: true } };
    case 'agent_status_online':
      return { ...rec, observed: { ...rec.observed, online: true } };
  }
}

/** 고객 안내를 꺼낸다. 시각이 시간 제한을 넘었으면 먼저 시간 초과를 정한다. 요청마다 한 번만 문구를 돌려주고, 이후에는 null */
export function takeReply(input: HandoffRecord, now: number): { record: HandoffRecord; reply: { state: HandoffState; text: string; mock: boolean } | null } {
  const rec = settleDeadline(input, now);
  if (!rec.decision || rec.replied) return { record: rec, reply: null };
  return { record: { ...rec, replied: true }, reply: { state: rec.decision.state, text: REPLIES[rec.decision.state], mock: rec.decision.mock } };
}
