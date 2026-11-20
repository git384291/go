// 광고 모의 수명주기(PM 7040572928) — 생성→상태→중단(재시도)→성과. 가상 입력만, 실게재·청구·외부 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCampaignDraft } from '../../src/server/advertising/campaignDraft';
import { createSimStore } from '../../src/server/advertising/campaignSim';

const mk = () => {
  const r = buildCampaignDraft({ draftId: 'moving', product: 'internet-tv', dailyBudgetKrw: 9000, totalBudgetKrw: 27000 });
  assert.ok(r.ok);
  return r.draft;
};

test('CS1 전체 흐름: 초안→모의 생성→상태→중단→성과, 실게재·청구·외부 호출 0, blocker 유지', () => {
  const s = createSimStore();
  const st = s.start(mk(), 'k1');
  assert.ok(st.ok && !st.replayed);
  if (!st.ok) return;
  const id = st.value.simId;
  assert.equal(st.value.mode, 'SIMULATION'); assert.equal(st.value.status, 'SIM_RUNNING');
  assert.deepEqual([st.value.liveDelivery, st.value.billedKrw, st.value.externalCalls], [false, 0, 0]);
  assert.ok(st.value.blockers.includes('CAP_NOT_VERIFIED') && st.value.blockers.length === 7);
  const q = s.status(id); assert.ok(q.ok && q.value.status === 'SIM_RUNNING');
  const p = s.stop(id); assert.ok(p.ok && !p.replayed && p.value.status === 'SIM_STOPPED');
  const rep = s.report(id);
  assert.ok(rep.ok);
  if (rep.ok) { assert.equal(rep.value.sample, true); assert.equal(rep.value.spendKrw, 0); assert.equal(rep.value.metrics.cpc, null); assert.equal(rep.value.metrics.ctr, null); }
});

test('CS2 중단 재시도는 중복 처리 없음(이벤트 2개 유지, replayed)', () => {
  const s = createSimStore();
  const a = s.start(mk(), 'k2'); assert.ok(a.ok); if (!a.ok) return;
  const id = a.value.simId;
  const first = s.stop(id), again = s.stop(id), third = s.stop(id);
  assert.ok(first.ok && again.ok && third.ok);
  if (first.ok && again.ok && third.ok) {
    assert.equal(first.replayed, false); assert.equal(again.replayed, true); assert.equal(third.replayed, true);
    assert.deepEqual(third.value.events.map((e) => e.type), ['SIM_STARTED', 'SIM_STOPPED']);
    assert.deepEqual(third.value, first.value);
  }
});

test('CS3 시작 재시도(같은 키)는 캠페인 1건만, 다른 키는 별개', () => {
  const s = createSimStore();
  const a = s.start(mk(), 'same'), b = s.start(mk(), 'same'), c = s.start(mk(), 'other');
  assert.ok(a.ok && b.ok && c.ok);
  if (a.ok && b.ok && c.ok) { assert.equal(b.replayed, true); assert.equal(a.value.simId, b.value.simId); assert.notEqual(a.value.simId, c.value.simId); }
});

test('CS4 이상 입력 거부: 비초안·승인 위조·blocker 제거·나쁜 키·없는 ID', () => {
  const s = createSimStore(); const d = mk();
  for (const bad of [null, [], 'x', {}, { ...d, executionAllowed: true }, { ...d, status: 'RUNNING' }, { ...d, blockers: [] }, { ...d, blockers: [1] }, { ...d, draftId: 5 }]) assert.deepEqual(s.start(bad, 'kk'), { ok: false, error: 'INVALID_INPUT' });
  for (const k of [undefined, '', 'a b', 'x'.repeat(41), 5]) assert.deepEqual(s.start(d, k), { ok: false, error: 'INVALID_INPUT' });
  for (const id of [undefined, 'sim-99', 7, '__proto__']) { assert.deepEqual(s.status(id), { ok: false, error: 'NOT_FOUND' }); assert.deepEqual(s.stop(id), { ok: false, error: 'NOT_FOUND' }); assert.deepEqual(s.report(id), { ok: false, error: 'NOT_FOUND' }); }
});

test('CS5 정적: 네트워크·환경·저장·로그·타이머·SDK 없음, 초안 모듈 비참조, 화면·API 미배선', () => {
  const src = readFileSync('src/server/advertising/campaignSim.ts', 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|fetch\(|console\.|setTimeout|setInterval|localStorage|postgres|supabase|openai|anthropic|naver|import\(|require\(|node:/i.test(src));
  assert.ok(!/campaignDraft|adDrafts|server\/advertising/.test(src));
  assert.ok(!/\b(approve|schedule|publish|charge|submit|execute)\w*\s*\(/i.test(src));
});
