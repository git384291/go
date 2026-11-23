// PM 7026277296: 상담원 연결 결과 판정(src/content/consultHandoff.ts) — 가상 요청·이벤트 식별자와 고정 상태만 사용한다.
// 실제 화면·route·SDK·웹훅·저장소 연결 없음. 실제 업체의 확인 신호는 아직 확인되지 않았다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applySignal,
  HANDOFF_ENABLED,
  REPLIES,
  settleDeadline,
  startHandoff,
  takeReply,
  type HandoffRecord,
  type Signal,
  type SignalKind,
} from '../../src/content/consultHandoff';

const T0 = 1_000_000;
const DEADLINE = 60_000;
const start = (over: Partial<Parameters<typeof startHandoff>[0]> = {}): HandoffRecord => startHandoff({ requestId: 'req-1', startedAt: T0, deadlineMs: DEADLINE, enabled: true, ...over });
let n = 0;
const sig = (kind: SignalKind, at: number, over: Partial<Signal> = {}): Signal => ({ eventId: `evt-${++n}`, requestId: 'req-1', kind, at, ...over });
const run = (rec: HandoffRecord, ...signals: Signal[]): HandoffRecord => signals.reduce(applySignal, rec);
const finalState = (rec: HandoffRecord, now = T0 + DEADLINE + 1) => takeReply(rec, now).reply?.state;

test('HF1 기본은 꺼짐: 상수 false, 켜지 않으면 즉시 "꺼짐"이며 이후 어떤 신호도 결과를 바꾸지 못한다', () => {
  assert.equal(HANDOFF_ENABLED, false);
  const rec = startHandoff({ requestId: 'req-1', startedAt: T0, deadlineMs: DEADLINE }); // enabled 생략 → 기본값
  assert.equal(rec.decision?.state, 'off');
  const after = run(rec, sig('human_ack_fixture', T0 + 5), sig('request_accepted', T0 + 6));
  assert.equal(after.decision?.state, 'off');
  const first = takeReply(after, T0 + 10);
  assert.equal(first.reply?.text, REPLIES.off);
  assert.equal(takeReply(first.record, T0 + 20).reply, null);
});

test('HF2 연결 확인 불가: 부재중 표시를 봤고 시간 안에 사람 확인이 없으면, 위치를 단정하지 않는 문구', () => {
  const rec = run(start(), sig('agent_status_away', T0 + 100));
  assert.equal(rec.decision, null); // 표시만으로는 아직 정하지 않는다
  const r = takeReply(rec, T0 + DEADLINE).reply;
  assert.equal(r?.state, 'connection_unavailable');
  assert.equal(r?.text, REPLIES.connection_unavailable);
  assert.ok(!/자리|부재|외출|퇴근|휴가|식사/.test(REPLIES.connection_unavailable), '담당자 실제 위치를 말하지 않는다');
  assert.ok(REPLIES.connection_unavailable.includes('이 문의가 전달됐다고 말씀드릴 수는 없어요'));
});

test('HF3 요청 수락·담당자 배정·상담방 생성은 각각, 그리고 모두 합쳐도 사람의 열람 증거가 아니다 → 전달 결과 불명', () => {
  const kinds: SignalKind[] = ['request_accepted', 'agent_assigned', 'room_created', 'agent_status_online'];
  for (const k of kinds) {
    const rec = run(start(), sig(k, T0 + 50));
    assert.equal(rec.decision, null, `${k} 하나로 결과가 정해지지 않는다`);
    assert.equal(finalState(rec), 'delivery_unknown', k);
  }
  const all = run(start(), ...kinds.map((k, i) => sig(k, T0 + 10 + i)));
  assert.equal(all.observed.accepted && all.observed.assigned && all.observed.roomCreated && all.observed.online, true);
  const r = takeReply(all, T0 + DEADLINE + 1).reply;
  assert.equal(r?.state, 'delivery_unknown');
  assert.equal(r?.mock, false);
  assert.ok(!/확인했어요|전달됐|접수|가입|연결됐/.test(r!.text.replace('전달됐는지 확인하지 못했어요', '')));
});

test('HF4 모의 확인: 같은 요청의 명시적 사람 확인 fixture에서만, 모의 표시', () => {
  const rec = run(start(), sig('request_accepted', T0 + 1), sig('human_ack_fixture', T0 + 500));
  const d = rec.decision;
  assert.equal(d?.state, 'mock_staff_confirmed');
  assert.equal(d?.mock, true);
  assert.equal(d?.real, false);
  const r = takeReply(rec, T0 + 600).reply;
  assert.equal(r?.text, REPLIES.mock_staff_confirmed);
  assert.equal(r?.mock, true);
});

test('HF5 다른 요청의 사람 확인은 무시: 이 요청은 시간 초과 후 불명, 다른 요청의 시각·결과에도 영향 없음', () => {
  const rec = run(start(), sig('human_ack_fixture', T0 + 100, { requestId: 'req-2' }), sig('human_ack_fixture', T0 + DEADLINE + 999, { requestId: 'req-2' }));
  assert.equal(rec.decision, null, '다른 요청 신호는 이 요청의 시간 제한도 건드리지 않는다');
  assert.deepEqual(rec.ignored.map((x) => x.reason), ['other_request', 'other_request']);
  assert.equal(finalState(rec), 'delivery_unknown');
});

test('HF6 중복 이벤트: 같은 eventId는 한 번만 반영, 안내도 한 번', () => {
  const ack = sig('human_ack_fixture', T0 + 10);
  const rec = run(start(), ack, ack, { ...ack, kind: 'delivery_error' });
  assert.equal(rec.decision?.state, 'mock_staff_confirmed');
  assert.equal(rec.ignored.filter((x) => x.reason === 'duplicate').length, 2);
  const a = takeReply(rec, T0 + 20);
  assert.ok(a.reply);
  assert.equal(takeReply(a.record, T0 + 30).reply, null);
  // 같은 eventId가 다른 종류로 재사용돼도 처음 것만 인정
  const rec2 = run(start(), sig('request_accepted', T0 + 1, { eventId: 'evt-same' }), sig('human_ack_fixture', T0 + 2, { eventId: 'evt-same' }));
  assert.equal(rec2.decision, null);
});

test('HF7 시간 초과 뒤 늦게 온 확인: 이미 낸 결과·안내가 바뀌지 않고 기록만 남는다', () => {
  const first = takeReply(start(), T0 + DEADLINE + 5);
  assert.equal(first.reply?.state, 'delivery_unknown');
  const late = applySignal(first.record, sig('human_ack_fixture', T0 + DEADLINE + 50));
  assert.equal(late.decision?.state, 'delivery_unknown');
  assert.equal(late.ignored.at(-1)?.reason, 'after_decision');
  assert.equal(takeReply(late, T0 + DEADLINE + 60).reply, null, '고객 안내는 두 번 나가지 않는다');
});

test('HF8 시간 제한 뒤의 시각을 가진 확인이 먼저 도착해도(시간 초과 처리 전) 결과는 시간 초과가 먼저다', () => {
  const rec = applySignal(start(), sig('human_ack_fixture', T0 + DEADLINE + 1));
  assert.equal(rec.decision?.state, 'delivery_unknown');
  assert.equal(finalState(rec), 'delivery_unknown');
  // 제한 시각 정각도 늦은 신호(제한은 도달 시점부터)
  const edge = applySignal(start(), sig('human_ack_fixture', T0 + DEADLINE));
  assert.equal(edge.decision?.state, 'delivery_unknown');
  const justBefore = applySignal(start(), sig('human_ack_fixture', T0 + DEADLINE - 1));
  assert.equal(justBefore.decision?.state, 'mock_staff_confirmed');
});

test('HF9 시작 전 시각의 확인은 인정하지 않는다(순서 뒤바뀜)', () => {
  const rec = applySignal(start(), sig('human_ack_fixture', T0 - 1));
  assert.equal(rec.decision, null);
  assert.equal(rec.ignored.at(-1)?.reason, 'stale');
  assert.equal(finalState(rec), 'delivery_unknown');
});

test('HF10 전달 오류 신호는 즉시 "전달 결과 불명", 이후 사람 확인으로 바뀌지 않는다', () => {
  const rec = run(start(), sig('delivery_error', T0 + 5), sig('human_ack_fixture', T0 + 6));
  assert.equal(rec.decision?.state, 'delivery_unknown');
  assert.equal(rec.ignored.at(-1)?.reason, 'after_decision');
});

test('HF11 부재중 표시 뒤에도 시간 안의 명시적 사람 확인이 우선하고, 확인 뒤의 부재중·오류 신호는 결과를 바꾸지 못한다', () => {
  const rec = run(start(), sig('agent_status_away', T0 + 1), sig('human_ack_fixture', T0 + 2), sig('agent_status_away', T0 + 3), sig('delivery_error', T0 + 4));
  assert.equal(rec.decision?.state, 'mock_staff_confirmed');
  assert.equal(takeReply(rec, T0 + 10).reply?.state, 'mock_staff_confirmed');
});

test('HF12 입력 오류: 형식이 틀린 신호는 무시하고, 시작 값이 틀리면 거부', () => {
  const bad = run(
    start(),
    { eventId: '', requestId: 'req-1', kind: 'human_ack_fixture', at: T0 + 1 },
    { eventId: 'e-x', requestId: 'req 1', kind: 'human_ack_fixture', at: T0 + 1 },
    { eventId: 'e-y', requestId: 'req-1', kind: 'real_vendor_ack' as SignalKind, at: T0 + 1 },
    { eventId: 'e-z', requestId: 'req-1', kind: 'human_ack_fixture', at: Number.NaN },
  );
  assert.equal(bad.decision, null);
  assert.equal(bad.ignored.length, 4);
  assert.deepEqual(bad.ignored.map((x) => x.reason), ['invalid_event_id', 'invalid_request_id', 'invalid_kind', 'invalid_time']);
  assert.ok(bad.ignored.every((x) => x.eventId === undefined && x.kind === undefined), '잘못된 신호의 값은 복사하지 않는다');
  assert.throws(() => startHandoff({ requestId: 'bad id', startedAt: T0, deadlineMs: 10 }), TypeError);
  assert.throws(() => startHandoff({ requestId: 'req-1', startedAt: T0, deadlineMs: 0 }), TypeError);
  assert.throws(() => startHandoff({ requestId: 'req-1', startedAt: Number.NaN, deadlineMs: 10 }), TypeError);
});

test('HF13 입력 기록을 바꾸지 않고, 요청끼리 상태를 공유하지 않는다', () => {
  const a = start({ requestId: 'req-a' });
  const frozen = Object.freeze({ ...a, seenEventIds: Object.freeze([...a.seenEventIds]), ignored: Object.freeze([...a.ignored]), observed: Object.freeze({ ...a.observed }) }) as HandoffRecord;
  const a2 = applySignal(frozen, sig('human_ack_fixture', T0 + 1, { requestId: 'req-a' }));
  assert.equal(frozen.decision, null);
  assert.equal(a2.decision?.state, 'mock_staff_confirmed');
  const b = start({ requestId: 'req-b' });
  assert.equal(b.decision, null);
  assert.equal(settleDeadline(frozen, T0 + DEADLINE).decision?.state, 'delivery_unknown');
  assert.equal(frozen.decision, null);
});

test('HF14 신호 순서를 섞어도(모든 순열) 안내는 정확히 한 번이고, 정해진 결과가 뒤에 온 신호로 바뀌지 않는다', () => {
  const base: [SignalKind, number][] = [['request_accepted', 10], ['agent_status_away', 20], ['human_ack_fixture', 30], ['delivery_error', 40], ['agent_assigned', 50]];
  const perms = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  let cases = 0;
  for (const order of perms([0, 1, 2, 3, 4])) {
    cases++;
    let rec = start();
    const emitted: string[] = [];
    const seenStates: string[] = [];
    for (const i of order) {
      rec = applySignal(rec, sig(base[i][0], T0 + base[i][1]));
      const t = takeReply(rec, T0 + base[i][1]);
      rec = t.record;
      if (t.reply) emitted.push(t.reply.state);
      if (rec.decision) seenStates.push(rec.decision.state);
    }
    const t = takeReply(rec, T0 + DEADLINE + 10);
    if (t.reply) emitted.push(t.reply.state);
    assert.equal(emitted.length, 1, `순서 ${order.join('')}: 안내 ${emitted.length}회`);
    assert.ok(seenStates.every((s) => s === seenStates[0]), `순서 ${order.join('')}: 결과가 바뀜`);
    // 첫 종결 신호(사람 확인 또는 전달 오류)가 결과를 정한다
    const firstTerminal = order.find((i) => base[i][0] === 'human_ack_fixture' || base[i][0] === 'delivery_error');
    assert.equal(emitted[0], base[firstTerminal!][0] === 'human_ack_fixture' ? 'mock_staff_confirmed' : 'delivery_unknown', `순서 ${order.join('')}`);
  }
  assert.equal(cases, 120);
});

test('HF15 고객 문구와 소스: 금액·접수·가입 표시 없음, "확인했어요"는 모의 확인 문구에만, 연결 코드(import·fetch·환경값·시계·난수) 없음', () => {
  for (const [state, text] of Object.entries(REPLIES)) {
    assert.ok(!/\d[\d,]*\s*(원|만원)|%|무료|할인|혜택|접수\s*(됐|완료)|가입\s*(됐|완료)|예약\s*(됐|완료)|연결됐/.test(text), state);
    if (state !== 'mock_staff_confirmed') assert.ok(!/확인했어요|담당자가 .* 확인/.test(text.replace('확인하지 못했어요', '')), state);
  }
  assert.ok(REPLIES.off.includes('확정해 드릴 수 없어요') && REPLIES.delivery_unknown.includes('확인하지 못했어요'));
  const src = readFileSync('src/content/consultHandoff.ts', 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'import 없음');
  assert.ok(!/fetch\(|process\.env|Date\.now|new Date|setTimeout|setInterval|Math\.random|localStorage|XMLHttpRequest|require\(/.test(src), '연결·시계·난수 코드 없음');
  assert.ok(/export const HANDOFF_ENABLED: boolean = false/.test(src));
});

test('HF16 기존 승인 문구와 일치: 담당자 연결 확인 불가 문구는 상담 예시(PR 승인)와 같다', async () => {
  const { EXAMPLES } = await import('../../src/content/consultPreview');
  assert.equal(EXAMPLES[1].answer, REPLIES.connection_unavailable);
});

// PM 7027915204: 유효하지 않은 입력에서는 수신 확인이 나오지 않는다(회귀 4건 + 변형)
const confirmed = (rec: HandoffRecord) => rec.decision?.state === 'mock_staff_confirmed';
const anyReplyStates = (rec: HandoffRecord) => takeReply(rec, T0 + 10).reply?.state;
const unsafe = (v: unknown) => v as never; // 잘못된 타입의 입력을 일부러 넘긴다

test('HF17 요청 ID가 빠졌거나 문자열이 아닌 시작은 거부, 식별자 없는 확인으로 모의 수신 확인이 성립하지 않는다', () => {
  // 시작 요청과 확인 이벤트 모두 요청 ID가 없는 경우: 시작 자체가 거부되어 기록이 만들어지지 않는다
  assert.throws(() => startHandoff(unsafe({ startedAt: T0, deadlineMs: DEADLINE, enabled: true })), TypeError);
  for (const bad of [undefined, null, 123, ['req-1'], { toString: () => 'req-1' }, true]) {
    assert.throws(() => startHandoff(unsafe({ requestId: bad, startedAt: T0, deadlineMs: DEADLINE, enabled: true })), TypeError, String(typeof bad));
  }
  assert.throws(() => startHandoff(unsafe(null)), TypeError);
  // 정상 요청에 요청 ID 없는 확인 이벤트
  const rec = applySignal(start(), unsafe({ eventId: 'evt-no-req', kind: 'human_ack_fixture', at: T0 + 5 }));
  assert.equal(confirmed(rec), false);
  assert.equal(rec.decision, null);
  assert.deepEqual(rec.ignored, [{ reason: 'invalid_request_id' }]);
  assert.equal(finalState(rec), 'delivery_unknown');
});

test('HF18 이벤트 ID가 빠졌거나 문자열이 아닌 확인은 무시(누락값이 문자열로 바뀌어 통과하지 않는다)', () => {
  for (const bad of [undefined, null, 5, ['evt-1'], { a: 1 }, '']) {
    const rec = applySignal(start(), unsafe({ eventId: bad, requestId: 'req-1', kind: 'human_ack_fixture', at: T0 + 5 }));
    assert.equal(confirmed(rec), false, String(typeof bad));
    assert.deepEqual(rec.ignored, [{ reason: 'invalid_event_id' }]);
  }
  // 종류·시각·신호 자체가 없거나 틀린 경우도 확인이 되지 않는다
  assert.deepEqual(applySignal(start(), unsafe({ eventId: 'e1', requestId: 'req-1', at: T0 + 5 })).ignored, [{ reason: 'invalid_kind' }]);
  assert.deepEqual(applySignal(start(), unsafe({ eventId: 'e2', requestId: 'req-1', kind: ['human_ack_fixture'], at: T0 + 5 })).ignored, [{ reason: 'invalid_kind' }]);
  assert.deepEqual(applySignal(start(), unsafe({ eventId: 'e3', requestId: 'req-1', kind: 'human_ack_fixture' })).ignored, [{ reason: 'invalid_time' }]);
  assert.deepEqual(applySignal(start(), unsafe('human_ack_fixture')).ignored, [{ reason: 'invalid_signal' }]);
  assert.deepEqual(applySignal(start(), unsafe(null)).ignored, [{ reason: 'invalid_signal' }]);
});

test('HF19 모의 경로는 불리언 true에서만: 문자열 "false"·"true"·숫자 등은 꺼짐', () => {
  for (const bad of ['false', 'true', 'TRUE', 1, 0, {}, [], 'yes']) {
    const rec = startHandoff(unsafe({ requestId: 'req-1', startedAt: T0, deadlineMs: DEADLINE, enabled: bad }));
    assert.equal(rec.decision?.state, 'off', String(bad));
    const after = applySignal(rec, sig('human_ack_fixture', T0 + 5));
    assert.equal(confirmed(after), false, String(bad));
    assert.equal(takeReply(after, T0 + 6).reply?.text, REPLIES.off);
  }
  assert.equal(start({ enabled: true }).decision, null); // 불리언 true만 열린다
  assert.equal(startHandoff({ requestId: 'req-1', startedAt: T0, deadlineMs: DEADLINE }).decision?.state, 'off'); // 생략은 기본값 꺼짐
});

test('HF20 잘못된 신호의 기록에는 고정 사유만 남고, 받은 자유문구가 결과(기록 전체)에 복사되지 않는다', () => {
  const FREE = '<script>홍길동 010-1234-5678 서울시 어딘가 1-1</script>';
  let rec = start();
  rec = applySignal(rec, unsafe({ eventId: FREE, requestId: 'req-1', kind: 'human_ack_fixture', at: T0 + 1 }));
  rec = applySignal(rec, unsafe({ eventId: 'evt-ok-1', requestId: 'req-1', kind: FREE, at: T0 + 2 }));
  rec = applySignal(rec, unsafe({ eventId: 'evt-ok-2', requestId: FREE, kind: 'human_ack_fixture', at: T0 + 3 }));
  rec = applySignal(rec, unsafe({ eventId: 'evt-ok-3', requestId: 'req-1', kind: 'human_ack_fixture', at: FREE }));
  assert.deepEqual(rec.ignored.map((x) => x.reason), ['invalid_event_id', 'invalid_kind', 'invalid_request_id', 'invalid_time']);
  const t = takeReply(rec, T0 + DEADLINE + 1);
  const dump = JSON.stringify(t);
  for (const piece of ['script', '홍길동', '010-1234', '서울시']) assert.ok(!dump.includes(piece), `${piece}가 결과에 복사됨`);
  // 형식이 맞는 값만(다른 요청 ID, 중복 등) 기록에 남는다
  const ok = applySignal(start(), sig('human_ack_fixture', T0 + 1, { requestId: 'req-other' }));
  assert.deepEqual(ok.ignored, [{ reason: 'other_request', eventId: ok.ignored[0].eventId, kind: 'human_ack_fixture' }]);
  assert.match(ok.ignored[0].eventId!, /^[A-Za-z0-9_-]{1,64}$/);
});

test('HF21 잘못된 입력 뒤에도 정상 같은 요청의 모의 확인·중복 안내 방지·마감 후 결과 보존은 유지된다', () => {
  let rec = start();
  rec = applySignal(rec, unsafe({ kind: 'human_ack_fixture', at: T0 + 1 })); // 잘못된 신호
  rec = applySignal(rec, unsafe({ eventId: 5, requestId: 'req-1', kind: 'human_ack_fixture', at: T0 + 2 }));
  assert.equal(rec.decision, null);
  const ack = sig('human_ack_fixture', T0 + 100);
  rec = run(rec, ack, ack); // 정상 확인 + 중복
  assert.equal(anyReplyStates(rec), 'mock_staff_confirmed');
  const first = takeReply(rec, T0 + 200);
  assert.equal(first.reply?.mock, true);
  assert.equal(takeReply(first.record, T0 + 300).reply, null, '중복 안내 없음');
  // 마감 후 결과 보존: 불명으로 정해진 뒤 정상 확인이 와도 바뀌지 않는다
  const timeout = takeReply(start(), T0 + DEADLINE + 1);
  const late = applySignal(timeout.record, sig('human_ack_fixture', T0 + DEADLINE + 2));
  assert.equal(late.decision?.state, 'delivery_unknown');
  assert.equal(takeReply(late, T0 + DEADLINE + 3).reply, null);
});

test('HF22 상담창 실패 안내는 연락 약속을 하지 않는다(상담창엔 연락처가 없음): 다시 보내기·신청 양식으로만 안내', () => {
  const src = readFileSync(new URL('../../src/components/ConsultAiChat.tsx', import.meta.url), 'utf8');
  const m = /export const SAFE = '([^']+)';/.exec(src);
  assert.ok(m, 'SAFE 문구 위치');
  assert.ok(!/담당자가|연락드리|안내드리겠/.test(m[1]), m[1]);
  assert.ok(/다시 보내|신청 양식/.test(m[1]), m[1]);
});
