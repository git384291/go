// 담당자 연결 모의 예시(비공개 상담 시안 전용, PM 7029405014). 검수한 판정 모듈(consultHandoff.ts)을 그대로 재사용한다.
// - 고정 가상 시각·요청 ID·이벤트만 쓴다. 실제 시계·난수·저장·전송·업체 연결 없음. 실제 업체의 확인 신호는 아직 미확인이다.
import { applySignal, startHandoff, takeReply, type HandoffState, type Signal } from './consultHandoff';

export const DEMO_REQUEST_ID = 'req-demo-1';
export const DEMO_DEADLINE_MS = 60_000; // 가상 마감 시각: 시작 후 60초(화면 표시용 값, 실제 시간 제한이 아님)
export const DEMO_QUESTION = '이사 가는데 설치비가 얼마고 토요일에 설치되나요?';
/** 모의 확인 문구 바로 옆에 붙이는 표시 */
export const MOCK_BADGE = '모의 결과 · 실제 문의 전송 없음';
export const DEMO_NOTE = '고정된 가상 시각과 가상 이벤트로 만든 예시예요. 문의가 실제로 전송되지 않아요.';

export type DemoCaseId = 'off' | 'unavailable' | 'unknown' | 'confirmed';
export type DemoCase = {
  readonly id: DemoCaseId;
  readonly label: string;
  readonly expectState: HandoffState;
  readonly enabled: boolean | undefined; // undefined = 기본값(꺼짐)
  readonly signals: readonly Signal[];
  readonly settleAt: number;
  /** 화면에 보여 주는 가상 이벤트 설명 */
  readonly events: string;
};

const s = (n: number, kind: Signal['kind'], at: number): Signal => ({ eventId: `evt-demo-${n}`, requestId: DEMO_REQUEST_ID, kind, at });

export const DEMO_CASES: readonly DemoCase[] = [
  { id: 'off', label: '경로 꺼짐', expectState: 'off', enabled: undefined, signals: [s(1, 'human_ack_fixture', 5_000)], settleAt: 6_000,
    events: '가상 이벤트: 담당자 연결 경로가 꺼져 있어요(기본값). 사람 확인 이벤트가 와도 결과가 바뀌지 않아요.' },
  { id: 'unavailable', label: '연결 확인 불가', expectState: 'connection_unavailable', enabled: true, signals: [s(2, 'request_accepted', 1_000), s(3, 'agent_status_away', 2_000)], settleAt: DEMO_DEADLINE_MS,
    events: '가상 이벤트: 요청 수락 → 상담 서비스의 담당자 상태 표시 "부재중" → 마감까지 사람 확인 없음. 이 표시는 담당자의 실제 위치가 아니에요.' },
  { id: 'unknown', label: '전달 결과 불명', expectState: 'delivery_unknown', enabled: true, signals: [s(4, 'request_accepted', 1_000), s(5, 'agent_assigned', 2_000), s(6, 'room_created', 3_000)], settleAt: DEMO_DEADLINE_MS,
    events: '가상 이벤트: 요청 수락 → 담당자 배정 → 상담방 생성 → 마감까지 사람 확인 없음. 이 세 가지는 사람이 읽었다는 증거가 아니에요.' },
  { id: 'confirmed', label: '모의 확인', expectState: 'mock_staff_confirmed', enabled: true, signals: [s(7, 'request_accepted', 1_000), s(8, 'human_ack_fixture', 20_000)], settleAt: 21_000,
    events: '가상 이벤트: 요청 수락 → 같은 요청에 대한 사람 확인(시험용 가상 이벤트). 실제 업체의 확인 신호가 아니에요.' },
];

export type DemoResult = { readonly state: HandoffState; readonly text: string; readonly mock: boolean };

/** 고정 사례 하나를 판정 모듈로 돌려 고객 안내를 한 번 꺼낸다(같은 사례는 항상 같은 결과) */
export function runDemoCase(id: DemoCaseId): DemoResult {
  const c = DEMO_CASES.find((x) => x.id === id);
  if (!c) throw new TypeError('알 수 없는 사례');
  let rec = startHandoff({ requestId: DEMO_REQUEST_ID, startedAt: 0, deadlineMs: DEMO_DEADLINE_MS, ...(c.enabled === undefined ? {} : { enabled: c.enabled }) });
  for (const sg of c.signals) rec = applySignal(rec, sg);
  const { reply } = takeReply(rec, c.settleAt);
  if (!reply) throw new Error('안내가 나오지 않았어요');
  return { state: reply.state, text: reply.text, mock: reply.mock };
}
