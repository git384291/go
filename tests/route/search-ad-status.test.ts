// 검색광고 캠페인 상태 매핑(PM 7042419085) — **스키마 기반 합성 fixture(PM 발췌 필드)이며 공식 응답 예시·실제 응답이 아니다.** 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapCampaignStatus } from '../../src/server/advertising/searchAdStatus';

const F = 'SYNTHETIC_FIXTURE' as const;
const m = (o: unknown) => { const r = mapCampaignStatus(o, F); assert.ok(r.ok); return r.ok ? r.value : (null as never); };

test('SS1 정상 매핑: 매체 상태·사용자 설정 분리 보존, ELIGIBLE은 게재 증거 아님', () => {
  const a = m({ status: 'ELIGIBLE', statusReason: 'CAMPAIGN_PENDING', userLock: false });
  assert.deepEqual([a.media.status, a.media.reason, a.userSetting, a.internal, a.conflict, a.countsAsDelivery], ['ELIGIBLE', 'CAMPAIGN_PENDING', 'UNLOCKED', 'ELIGIBLE_NOT_DELIVERY_PROOF', false, false]);
  assert.equal(a.origin, F);
  const b = m({ status: 'PAUSED', statusReason: 'CAMPAIGN_PAUSED', userLock: true });
  assert.deepEqual([b.media.status, b.userSetting, b.internal], ['PAUSED', 'LOCKED', 'PAUSED']);
  const c = m({ status: 'DELETED', statusReason: 'CAMPAIGN_ENDED', userLock: false });
  assert.equal(c.internal, 'DELETED');
  const d = m({ status: 'ELIGIBLE', statusReason: 'CAMPAIGN_LIMITED_BY_BUDGET', userLock: false });
  assert.equal(d.media.reason, 'CAMPAIGN_LIMITED_BY_BUDGET'); assert.equal(d.countsAsDelivery, false);
});

test('SS2 모든 결과에서 countsAsDelivery false(ELIGIBLE 포함 전 조합)', () => {
  for (const status of ['ELIGIBLE', 'PAUSED', 'DELETED', 'X']) for (const userLock of [true, false, undefined]) for (const statusReason of ['CAMPAIGN_PAUSED', 'CAMPAIGN_PENDING', 'CAMPAIGN_ENDED', 'CAMPAIGN_LIMITED_BY_BUDGET', undefined]) {
    assert.equal(m({ status, userLock, statusReason }).countsAsDelivery, false);
  }
});

test('SS3 누락·미지 값은 던지지 않고 UNKNOWN·검토 필요, 원문은 걸러서만 보존', () => {
  assert.equal(m({}).internal, 'NEEDS_REVIEW');
  assert.deepEqual([m({}).media.status, m({}).userSetting, m({}).media.rawStatus], ['UNKNOWN', 'UNKNOWN', null]);
  const n = m({ status: 'NEW_STATE', userLock: false });
  assert.deepEqual([n.media.status, n.media.rawStatus, n.internal], ['UNKNOWN', 'NEW_STATE', 'NEEDS_REVIEW']);
  assert.equal(m({ status: 'ELIGIBLE', userLock: false, statusReason: 'NEW_REASON' }).internal, 'NEEDS_REVIEW');
  assert.equal(m({ status: 'ELIGIBLE', userLock: false, statusReason: 'NEW_REASON' }).media.rawReason, 'NEW_REASON');
  assert.equal(m({ status: '<script>x', userLock: false }).media.rawStatus, null, '허용 문자 밖 원문은 보존하지 않음');
  assert.equal(m({ status: 'ELIGIBLE', userLock: 'false' }).userSetting, 'UNKNOWN', '문자열 userLock은 불리언으로 취급하지 않음');
  assert.equal(m({ status: 'ELIGIBLE', userLock: 0 }).internal, 'NEEDS_REVIEW');
  assert.equal(m({ status: 'ELIGIBLE', userLock: false, statusReason: null }).media.reason, 'NONE');
});

test('SS4 충돌은 검토 필요: ELIGIBLE인데 userLock true / PAUSED·UNLOCKED인데 사유 없음', () => {
  const a = m({ status: 'ELIGIBLE', userLock: true, statusReason: 'CAMPAIGN_PAUSED' });
  assert.deepEqual([a.conflict, a.internal, a.userSetting, a.media.status], [true, 'NEEDS_REVIEW', 'LOCKED', 'ELIGIBLE']);
  assert.equal(m({ status: 'PAUSED', userLock: false }).conflict, true);
  assert.equal(m({ status: 'PAUSED', userLock: false, statusReason: 'CAMPAIGN_PAUSED' }).conflict, false);
});

test('SS5 이상 입력·출처 거부, 추가 키는 무시하고 되돌리지 않으며 접근자 예외는 고정 실패', () => {
  for (const bad of [null, undefined, 5, 'x', []]) assert.deepEqual(mapCampaignStatus(bad, F), { ok: false, error: 'INVALID_INPUT' });
  assert.deepEqual(mapCampaignStatus({ status: 'ELIGIBLE', userLock: false }, 'REAL' as never), { ok: false, error: 'INVALID_INPUT' });
  const r = m({ status: 'ELIGIBLE', userLock: false, name: '비밀', nccCampaignId: 'x' });
  assert.deepEqual(Object.keys(r).sort(), ['conflict', 'countsAsDelivery', 'internal', 'media', 'origin', 'userSetting']);
  assert.ok(!JSON.stringify(r).includes('비밀'));
  const thrower = { get status(): string { throw new Error('boom'); } };
  assert.deepEqual(mapCampaignStatus(thrower, F), { ok: false, error: 'INVALID_INPUT' });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.media));
});

test('SS6 정적: 네트워크·환경·저장·로그·타이머·SDK 없음, import는 server-only뿐, 화면·API 미배선', () => {
  const src = readFileSync('src/server/advertising/searchAdStatus.ts', 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|fetch\(|console\.|setTimeout|setInterval|localStorage|postgres|supabase|openai|anthropic|import\(|require\(|node:/i.test(src));
  assert.deepEqual(readFileSync('src/server/advertising/searchAdStatus.ts', 'utf8').match(/^import .+$/gm), ["import 'server-only';"]);
});
