// 검색광고 캠페인 중단 요청→재조회 판정(PM 7042822412) — **스키마 기반 합성 fixture(PM 발췌), 공식·실제 응답 아님.** 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStopRequest, evaluateStop, MAX_STOP_ATTEMPTS, type StopEvaluation } from '../../src/server/advertising/searchAdStop';

const F = 'SYNTHETIC_FIXTURE' as const;
const PAUSED = { httpStatus: 200, body: { status: 'PAUSED', statusReason: 'CAMPAIGN_PAUSED', userLock: true } };
const ELIGIBLE = { httpStatus: 200, body: { status: 'ELIGIBLE', statusReason: 'CAMPAIGN_PENDING', userLock: false } };
const ev = (put: unknown, re: unknown, attempt = 1) => { const r = evaluateStop(put as never, re as never, attempt, F); assert.ok('verdict' in r); return r as StopEvaluation; };

test('SX1 요청 서술: 보내지 않음(sendable false), userLock 본문만, 본문 스키마 UNVERIFIED, 이상 ID 거부', () => {
  const r = buildStopRequest('cmp-a001-01-000000000001'); assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.request, { method: 'PUT', path: '/api/ncc/campaigns/cmp-a001-01-000000000001', fields: 'userLock', body: { userLock: true }, bodySchema: 'UNVERIFIED', sendable: false });
  for (const bad of [undefined, '', 'a/b', '../x', 'a b', 'x'.repeat(51), 5]) assert.deepEqual(buildStopRequest(bad), { ok: false, error: 'INVALID_INPUT' });
});

test('SX2 요청 성공과 중단 확인 구분: 200 + 재조회 PAUSED·userLock true만 STOP_CONFIRMED', () => {
  const a = ev({ httpStatus: 200, body: PAUSED.body }, PAUSED);
  assert.deepEqual([a.request, a.confirmation, a.verdict, a.retry], ['ACCEPTED_200', 'CONFIRMED_PAUSED', 'STOP_CONFIRMED', 'NONE']);
  const b = ev({ httpStatus: 201 }, PAUSED);
  assert.deepEqual([b.request, b.verdict], ['ACCEPTED_201_BODY_UNSPECIFIED', 'STOP_CONFIRMED']);
  // PUT 200 본문이 PAUSED여도 재조회가 ELIGIBLE이면 확인 아님
  const c = ev({ httpStatus: 200, body: PAUSED.body }, ELIGIBLE);
  assert.deepEqual([c.confirmation, c.verdict, c.retry], ['MISMATCH', 'REQUEST_OK_NOT_CONFIRMED', 'RETRY']);
});

test('SX3 응답 누락: 재조회 없음·실패·본문 없음은 확인 아님, PUT 응답 없음은 검토 필요', () => {
  for (const re of [null, undefined, { httpStatus: 500 }, { httpStatus: 200 }, { httpStatus: 200, body: null }, { httpStatus: 404 }]) {
    const r = ev({ httpStatus: 200 }, re); assert.deepEqual([r.confirmation, r.verdict, r.retry], ['REFETCH_MISSING', 'REQUEST_OK_NOT_CONFIRMED', 'RETRY']);
  }
  const n = ev(null, ELIGIBLE); assert.deepEqual([n.request, n.verdict], ['NO_RESPONSE', 'NEEDS_REVIEW']);
  assert.equal(ev(null, PAUSED).verdict, 'NEEDS_REVIEW', '요청 응답 없이 PAUSED만 보여도 우리 요청의 결과로 단정하지 않음');
  assert.equal(ev({ httpStatus: 500 }, null).request, 'UNKNOWN_HTTP');
});

test('SX4 상태 불일치: userLock false 유지·ELIGIBLE·미지 상태·충돌은 확인 아님', () => {
  assert.equal(ev({ httpStatus: 200 }, ELIGIBLE).confirmation, 'MISMATCH');
  assert.equal(ev({ httpStatus: 200 }, { httpStatus: 200, body: { status: 'PAUSED', statusReason: 'CAMPAIGN_PAUSED', userLock: false } }).confirmation, 'MISMATCH');
  assert.equal(ev({ httpStatus: 200 }, { httpStatus: 200, body: { status: 'NEW_STATE', userLock: true } }).confirmation, 'REFETCH_UNKNOWN');
  assert.equal(ev({ httpStatus: 200 }, { httpStatus: 200, body: { status: 'ELIGIBLE', userLock: true } }).verdict, 'REQUEST_OK_NOT_CONFIRMED');
  assert.equal(ev({ httpStatus: 200 }, { httpStatus: 200, body: { status: 'DELETED', statusReason: 'CAMPAIGN_ENDED', userLock: false } }).confirmation, 'NOT_CONFIRMED');
});

test('SX5 거절 401·403·404: 재시도 없음(REQUEST_REJECTED), 재조회가 PAUSED여도 확인으로 세지 않음', () => {
  for (const code of [401, 403, 404]) { const r = ev({ httpStatus: code }, PAUSED); assert.deepEqual([r.request, r.verdict, r.retry], [`REJECTED_${code}`, 'REQUEST_REJECTED', 'NONE']); }
});

test('SX6 재시도: 3회까지 RETRY 후 ESCALATE, 3회째 성공이면 확인, 범위 밖 시도 거부', () => {
  assert.deepEqual([1, 2, 3].map((a) => ev({ httpStatus: 200 }, ELIGIBLE, a).retry), ['RETRY', 'RETRY', 'ESCALATE']);
  assert.equal(MAX_STOP_ATTEMPTS, 3);
  const last = ev({ httpStatus: 200 }, PAUSED, 3); assert.deepEqual([last.verdict, last.retry], ['STOP_CONFIRMED', 'NONE']);
  // 재시도 시퀀스: 1회 PUT 응답 유실·재조회 미반영 → 2회 반영, 중복 확인 상태가 아님
  const s1 = ev(null, ELIGIBLE, 1), s2 = ev({ httpStatus: 200 }, PAUSED, 2);
  assert.deepEqual([s1.verdict, s1.retry, s2.verdict, s2.retry], ['NEEDS_REVIEW', 'RETRY', 'STOP_CONFIRMED', 'NONE']);
  for (const a of [0, 4, 1.5, '1', undefined, NaN]) assert.deepEqual(evaluateStop({ httpStatus: 200 }, PAUSED, a as never, F), { ok: false, error: 'INVALID_INPUT' });
});

test('SX7 이상 입력·접근자 예외는 고정 실패, 결과는 동결·게재 집계 없음, 정적 검사', () => {
  const thrower = { httpStatus: 200, get body(): never { throw new Error('boom'); } };
  assert.deepEqual(evaluateStop({ httpStatus: 200 }, thrower as never, 1, F), { ok: false, error: 'INVALID_INPUT' });
  const r = ev({ httpStatus: 200 }, PAUSED); assert.ok(Object.isFrozen(r));
  assert.equal(r.refetched?.countsAsDelivery, false);
  const full = readFileSync('src/server/advertising/searchAdStop.ts', 'utf8'); const src = full.replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|fetch\(|console\.|setTimeout|setInterval|localStorage|postgres|supabase|openai|anthropic|import\(|require\(|node:/i.test(src));
  assert.deepEqual(full.match(/^import .+$/gm), ["import 'server-only';", "import { mapCampaignStatus, type MappedStatus, type Origin } from './searchAdStatus';"]);
});
