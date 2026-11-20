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

// ── PM 7041019751: 실제 생성기 DTO 직접 전달 ──
import { generateAdCopy, type AdCopyGenerator } from '../../src/server/advertising/adGeneration';
import { CAMPAIGN_BLOCKERS } from '../../src/server/advertising/campaignDraft';
import { computeMetrics } from '../../src/content/adMetrics';

const GOOD = { title: '이사 전 인터넷·TV 확인', description: '새집 인터넷·TV 조건을 확인하세요. 설치 가능 여부는 별도 확인이 필요합니다.' };
const fakeGen = () => { let calls = 0; const g: AdCopyGenerator = { generate: async () => { calls += 1; return { kind: 'ok', data: { ...GOOD }, called: true }; } }; return { g, calls: () => calls }; };

test('CS6 실제 생성기 DTO 그대로 → 모의 시작→조회→중단(재시도)→성과, 외부 호출·청구 0', async () => {
  const { g, calls } = fakeGen();
  const gen = await generateAdCopy({ situationId: 'moving', product: 'internet-tv' }, { generator: g });
  assert.equal(gen.ok, true);
  assert.equal(calls(), 1, '가짜 생성기 1회(실제 호출 아님)');
  const s = createSimStore();
  const st = s.start(gen, 'gen1');
  assert.ok(st.ok); if (!st.ok) return;
  assert.equal(st.value.copySource, 'model'); assert.equal(st.value.draftId, 'moving'); assert.equal(st.value.status, 'SIM_RUNNING');
  assert.deepEqual([st.value.liveDelivery, st.value.billedKrw, st.value.externalCalls], [false, 0, 0]);
  assert.equal(s.start(gen, 'gen1').ok && (s.start(gen, 'gen1') as { replayed: boolean }).replayed, true);
  const q = s.status(st.value.simId); assert.ok(q.ok && q.value.status === 'SIM_RUNNING');
  const a = s.stop(st.value.simId), b = s.stop(st.value.simId);
  assert.ok(a.ok && b.ok && !a.replayed && b.replayed);
  if (b.ok) assert.equal(b.value.events.length, 2);
  assert.ok(s.report(st.value.simId).ok);
  assert.equal(calls(), 1, '모의 흐름이 생성기를 다시 부르지 않음');
});

test('CS7 생성기 DTO의 blocker는 초안 모듈 목록과 같고, 실패 DTO·승인 위조는 거부', async () => {
  const { g } = fakeGen();
  const gen = await generateAdCopy({ situationId: 'contract_end', product: 'internet-tv' }, { generator: g });
  const s = createSimStore();
  const st = s.start(gen, 'g2'); assert.ok(st.ok);
  if (st.ok) assert.deepEqual([...st.value.blockers], [...CAMPAIGN_BLOCKERS]);
  const bad = await generateAdCopy({ situationId: 'moving', product: 'internet-tv' }, { generator: null });
  assert.deepEqual(s.start(bad, 'g3'), { ok: false, error: 'INVALID_INPUT' });
  assert.deepEqual(s.start({ ...(gen as object), executionAllowed: true }, 'g4'), { ok: false, error: 'INVALID_INPUT' });
  assert.deepEqual(s.start({ ...(gen as object), blockers: [] }, 'g5'), { ok: false, error: 'INVALID_INPUT' });
});

test('CS8 실적 집계와 분리: 성과는 표본 표지·지출 0, 저장소끼리 상태 공유 없음, 실데이터 입력 경로 없음', () => {
  const a = createSimStore(), b = createSimStore();
  const x = a.start(mk(), 'k'); assert.ok(x.ok); if (!x.ok) return;
  assert.deepEqual(b.status(x.value.simId), { ok: false, error: 'NOT_FOUND' });
  const r = a.report(x.value.simId); assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.sample, true); assert.equal(r.value.spendKrw, 0);
    assert.deepEqual(r.value.metrics, computeMetrics({ model: 'cohort', period: { from: '2026-11-17', to: '2026-11-23' }, windowDays: 30, source: 'sample', traffic: 'paid', format: 'search', spendKrw: 0, spendIncludesVat: false, impressions: 0, clicks: 0, visits: 0, conversions: { consult_request: 0 }, recognizedRevenueKrw: null }));
  }
  const src = readFileSync('src/server/advertising/campaignSim.ts', 'utf8');
  assert.deepEqual(src.match(/^import .+$/gm), ["import 'server-only';", "import { computeMetrics, type Metrics } from '@/content/adMetrics';"]);
  assert.match(src, /source: 'sample'/);
  assert.equal(a.report.length, 1, 'report는 simId만 받는다(지출·노출 입력 매개변수 없음)');
});
