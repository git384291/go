// 광고 활성화 예약 실행(PM 11/25 ②③) — 가짜 DB·모의 플랫폼만. 실제 Google Ads 호출·ENABLED·광고비 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAdScheduler, type SchedulerTx } from '../../src/server/admin/adScheduler';
import { adSchedulerHandler } from '../../src/server/admin/adSchedulerRoute';
import { mockPlatform, PlatformError, type AdPlatform } from '../../src/server/advertising/platform';

const RID = '11111111-2222-4333-8444-555555555555';
const JOB = { id: '22222222-3333-4444-8555-666666666666', campaign: 'camp-s', external_id: 'ext-9' };
type DbOpt = { job?: unknown; claimThrows?: boolean; gate?: unknown; gateThrows?: boolean; finishThrows?: boolean; stopThrows?: boolean };
function db(o: DbOpt = {}) {
  const calls: { q: string; v: unknown[] }[] = [];
  const runAsScheduler = async <T,>(fn: (tx: SchedulerTx) => Promise<T>): Promise<T> => fn((async (s: TemplateStringsArray, ...v: unknown[]) => {
    const q = s.join('?'); calls.push({ q, v });
    if (q.includes('ad_sched_claim')) { if (o.claimThrows) throw new Error('db down'); return [{ r: { job: 'job' in o ? o.job : JOB } }]; }
    if (q.includes('ad_sched_gate')) { if (o.gateThrows) throw new Error('db down'); return [{ r: 'gate' in o ? o.gate : { decision: 'ALLOW' } }]; }
    if (q.includes('ad_sched_finish')) { if (o.finishThrows) throw new Error('x'); return [{}]; }
    if (q.includes('ad_monitor_stop')) { if (o.stopThrows) throw new Error('x'); return [{ r: {} }]; }
    throw new Error('unexpected ' + q);
  }) as SchedulerTx);
  const of = (name: string) => calls.filter((c) => c.q.includes(name)).map((c) => c.v);
  return { runAsScheduler, calls, finishes: () => of('ad_sched_finish').map((v) => [v[2], v[3]]), stops: () => of('ad_monitor_stop'), gates: () => of('ad_sched_gate').length };
}
type PlatOpt = { live?: boolean; pre?: unknown; post?: unknown; preThrows?: unknown; enable?: 'ok' | 'failed' | 'unknown' | 'hang'; pauseOk?: boolean; noEnable?: boolean };
function plat(o: PlatOpt = {}) {
  const c = { status: 0, enable: 0, pause: 0 };
  const p: AdPlatform = { ...mockPlatform, live: o.live ?? false,
    async pause() { c.pause++; if (o.pauseOk === false) throw new Error('down'); return { paused: true }; },
    async campaignStatus() { c.status++; if (c.status === 1) { if (o.preThrows) throw o.preThrows; return o.pre ?? { status: 'PAUSED' }; } return 'post' in o ? o.post : { status: 'ENABLED' }; },
    async enable() {
      c.enable++;
      if (o.enable === 'failed') throw new PlatformError('failed', 'REJECTED');
      if (o.enable === 'unknown') throw new Error('5xx');
      if (o.enable === 'hang') return new Promise(() => {});
      return { enabled: true };
    } };
  if (o.noEnable) { delete (p as { enable?: unknown }).enable; }
  return { p, c };
}
const run = (d: ReturnType<typeof db>, p: AdPlatform | null) => runAdScheduler({ platform: p, runAsScheduler: d.runAsScheduler, runId: RID });

test('SC1 정상: 예약 잡음 → PAUSED 확인 → DB 최종 판정 → 활성화(모의) → 다시 읽어 ENABLED → enabled 기록', async () => {
  const d = db(); const pl = plat();
  const r = await run(d, pl.p);
  assert.deepEqual([r.ok, r.code, r.campaign, r.enableCalls], [true, 'ENABLED', 'camp-s', 1]);
  assert.deepEqual(d.finishes(), [['enabled', 'ENABLED']]);
  assert.deepEqual([pl.c.status, pl.c.enable, pl.c.pause], [2, 1, 0], '전후 상태 확인 2회');
  const order = d.calls.map((x) => x.q.match(/api\.(\w+)/)?.[1]);
  assert.deepEqual(order, ['ad_sched_claim', 'ad_sched_gate', 'ad_sched_finish']);
});

test('SC2 실행 시각 전·예약 없음(IDLE): 매체 호출 0회 / 플랫폼 없음: 예약을 잡지도 않음 / 잘못된 회차 ID: 아무것도 안 함', async () => {
  const d = db({ job: null }); const pl = plat();
  assert.deepEqual([(await run(d, pl.p)).code, pl.c.status + pl.c.enable], ['IDLE', 0]);
  const d2 = db();
  assert.equal((await run(d2, null)).code, 'PLATFORM_UNAVAILABLE');
  assert.equal(d2.calls.length, 0);
  const d3 = db();
  assert.equal((await runAdScheduler({ platform: plat().p, runAsScheduler: d3.runAsScheduler, runId: 'x' })).code, 'CLAIM_FAILED');
  assert.equal(d3.calls.length, 0);
});

test('SC3 실제(live) 플랫폼은 ENABLED 금지: 상태 조회·활성화 0회, 예약은 failed(LIVE_ENABLE_FORBIDDEN) / 활성화 기능 없는 어댑터도 failed', async () => {
  const d = db(); const pl = plat({ live: true });
  const r = await run(d, pl.p);
  assert.deepEqual([r.ok, r.code, pl.c.status, pl.c.enable], [false, 'LIVE_ENABLE_FORBIDDEN', 0, 0]);
  assert.deepEqual(d.finishes(), [['failed', 'LIVE_ENABLE_FORBIDDEN']]);
  assert.equal(d.gates(), 0, 'DB 최종 판정까지 가지 않음');
  const d2 = db(); const p2 = plat({ noEnable: true });
  assert.equal((await run(d2, p2.p)).code, 'ENABLE_UNSUPPORTED');
  assert.equal(p2.c.enable, 0);
});

test('SC4 DB 최종 판정 BLOCK(예산 0원·승인 취소·키워드·CPC·감시 등): 활성화 요청 0회, 결과 BLOCKED(사유 그대로) / 판정 오류·형식 이상은 failed(fail-closed)', async () => {
  for (const reason of ['MONTHLY_BUDGET_UNSET', 'NO_APPROVAL', 'KEYWORD_NOT_APPROVED', 'CPC_POLICY_UNSET', 'MONITOR_STALE', 'STOP_PENDING']) {
    const d = db({ gate: { decision: 'BLOCK', reason } }); const pl = plat();
    const r = await run(d, pl.p);
    assert.deepEqual([r.code, r.reason, pl.c.enable, r.enableCalls], ['BLOCKED', reason, 0, 0], reason);
  }
  for (const o of [{ gateThrows: true }, { gate: { decision: 'MAYBE' } }, { gate: null }] as DbOpt[]) {
    const d = db(o); const pl = plat();
    const r = await run(d, pl.p);
    assert.deepEqual([r.ok, r.code, pl.c.enable], [false, 'GATE_FAILED', 0]);
    assert.deepEqual(d.finishes(), [['failed', 'GATE_ERROR']]);
  }
});

test('SC5 활성화 전 상태 재확인: 조회 실패는 failed(변경 없음), PAUSED 아님(이미 ENABLED·이상한 값)은 중지·불명(unknown 경고)', async () => {
  const d = db(); const pl = plat({ preThrows: new PlatformError('failed', 'DOWN') });
  assert.deepEqual([(await run(d, pl.p)).code, pl.c.enable, d.gates()], ['PRECHECK_FAILED', 0, 0]);
  assert.deepEqual(d.finishes(), [['failed', 'PRECHECK_FAILED']]);
  for (const pre of [{ status: 'ENABLED' }, { status: 'REMOVED' }, {}, 'PAUSED']) {
    const d2 = db(); const p2 = plat({ pre });
    const r = await run(d2, p2.p);
    assert.deepEqual([r.ok, r.code, p2.c.enable, p2.c.pause], [false, 'NOT_PAUSED', 0, 1], JSON.stringify(pre));
    assert.deepEqual(d2.finishes(), [['unknown', 'NOT_PAUSED']]);
    assert.deepEqual(d2.stops(), [['camp-s', 'ENABLE_PRECHECK_MISMATCH', true]]);
  }
});

test('SC6 활성화 뒤 다시 읽어 ENABLED가 아니면(PAUSED·조회 실패) 중지 + unknown(경고) — 성공으로 표시하지 않음', async () => {
  for (const post of [{ status: 'PAUSED' }, { status: 'ENABLED ' }, null]) {
    const d = db(); const pl = plat({ post });
    const r = await run(d, pl.p);
    assert.deepEqual([r.ok, r.code, pl.c.pause], [false, 'POSTCHECK_MISMATCH', 1], JSON.stringify(post));
    assert.deepEqual(d.finishes(), [['unknown', 'POSTCHECK_MISMATCH']]);
  }
});

test('SC7 API 장애·시간 초과: 활성화 거부(failed)·불명(5xx)·응답 없음(10초) → 중지·failed/unknown, 재시도 없음', { timeout: 30_000 }, async () => {
  const d = db(); const pl = plat({ enable: 'failed' });
  assert.equal((await run(d, pl.p)).code, 'ENABLE_FAILED');
  assert.deepEqual(d.finishes(), [['failed', 'ENABLE_FAILED']]);
  assert.equal(pl.c.enable, 1);
  const d2 = db(); const p2 = plat({ enable: 'unknown' });
  assert.equal((await run(d2, p2.p)).code, 'ENABLE_UNKNOWN');
  assert.deepEqual(d2.finishes(), [['unknown', 'ENABLE_UNKNOWN']]);
  assert.equal(p2.c.pause, 1, '불명이면 즉시 중지 요청');
  const d3 = db(); const p3 = plat({ enable: 'hang' });
  const r3 = await run(d3, p3.p);
  assert.deepEqual([r3.code, p3.c.enable, p3.c.pause], ['ENABLE_UNKNOWN', 1, 1]);
});

test('SC8 중지 실패는 성공 처리 금지: pause 실패·중지 기록 실패 → ok=false·STOP_FAILED, DB에는 paused=false(경고·계정 전체 차단)', async () => {
  const d = db(); const pl = plat({ post: { status: 'PAUSED' }, pauseOk: false });
  const r = await run(d, pl.p);
  assert.deepEqual([r.ok, r.code], [false, 'STOP_FAILED']);
  assert.deepEqual(d.stops(), [['camp-s', 'ENABLE_POSTCHECK', false]]);
  const d2 = db({ stopThrows: true }); const p2 = plat({ enable: 'unknown' });
  assert.deepEqual([(await run(d2, p2.p)).code], ['STOP_FAILED']);
  // 매체는 ENABLED인데 결과 기록 실패 → 성공 아님, 중지
  const d3 = db({ finishThrows: true }); const p3 = plat();
  const r3 = await run(d3, p3.p);
  assert.deepEqual([r3.ok, r3.code, p3.c.pause], [false, 'FINISH_FAILED', 1]);
});

test('SC9 잡은 예약 형식 이상(ID·캠페인·외부 ID) → 활성화 없음, 예약 조회 실패 → CLAIM_FAILED', async () => {
  for (const job of [{ ...JOB, id: 'x' }, { ...JOB, campaign: 'Bad!' }, 'job']) {
    const d = db({ job }); const pl = plat();
    assert.equal((await run(d, pl.p)).code, 'BAD_JOB');
    assert.equal(pl.c.enable + pl.c.status, 0);
  }
  const d = db({ job: { ...JOB, external_id: null } }); const pl = plat();
  assert.equal((await run(d, pl.p)).code, 'BAD_JOB');
  assert.deepEqual(d.finishes(), [['failed', 'NO_EXTERNAL_ID']]);
  const d2 = db({ claimThrows: true });
  assert.equal((await run(d2, plat().p)).code, 'CLAIM_FAILED');
});

test('SC10 모의 플랫폼 실제 동작: launch는 PAUSED, enable 뒤 ENABLED, pause 뒤 PAUSED(메모리, 외부 호출 없음)', async () => {
  const o = { deadlineAt: Date.now() + 1000 };
  const ref = { campaign: 'camp-z', externalId: 'mock-sc10' };
  assert.deepEqual(await mockPlatform.campaignStatus!(ref, o), { status: 'PAUSED' });
  await mockPlatform.enable!(ref, o);
  assert.deepEqual(await mockPlatform.campaignStatus!(ref, o), { status: 'ENABLED' });
  await mockPlatform.pause(ref, o);
  assert.deepEqual(await mockPlatform.campaignStatus!(ref, o), { status: 'PAUSED' });
  await assert.rejects(mockPlatform.enable!({ campaign: 'camp-z', externalId: null }, o));
});

test('SC11 스케줄러 경로: 꺼짐(비밀 없음·짧음·DB 꺼짐) 503, CRON_SECRET만 있으면 꺼짐(호스팅 비종속), GET 405, 틀린 인증 401, 맞으면 실행', async () => {
  const S = 's'.repeat(40);
  const ok = { ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01', AD_SCHEDULER_SECRET: S };
  let ran = 0;
  const fake = (async () => { ran++; return { ok: true, code: 'IDLE', campaign: null, reason: null, enableCalls: 0 }; }) as unknown as typeof runAdScheduler;
  const req = (auth?: string, method = 'POST') => new Request('http://x/api/internal/ad-scheduler', { method, headers: auth ? { authorization: auth } : {} });
  for (const env of [{ ...ok, AD_SCHEDULER_SECRET: undefined }, { ...ok, AD_SCHEDULER_SECRET: 'short' }, { ...ok, ADMIN_AD_SOURCE: undefined }, { ...ok, AD_SCHEDULER_SECRET: undefined, CRON_SECRET: S }, { ...ok, NODE_ENV: 'production' }, { ...ok, VERCEL: '1' }]) {
    assert.equal((await adSchedulerHandler(req(`Bearer ${S}`), env, fake)).status, 503);
  }
  assert.equal((await adSchedulerHandler(req(`Bearer ${S}`, 'GET'), ok, fake)).status, 405);
  assert.equal((await adSchedulerHandler(req('Bearer wrong'), ok, fake)).status, 401);
  assert.equal(ran, 0);
  const r = await adSchedulerHandler(req(`Bearer ${S}`), ok, fake);
  assert.equal(r.status, 200);
  assert.equal(ran, 1);
});

test('SC12 정적: 실제 Google Ads 어댑터에 활성화 기능 없음(ENABLED 전환 코드 없음), 스케줄러 모듈은 로그·환경값·타이머 직접 사용 없음, 경로는 POST만', () => {
  const g = readFileSync('src/server/advertising/googleAdsPlatform.ts', 'utf8');
  assert.ok(!/\benable\s*\(/.test(g) && !/campaignStatus/.test(g), 'Google Ads 어댑터에 enable·campaignStatus 없음');
  const s = readFileSync('src/server/admin/adScheduler.ts', 'utf8');
  assert.ok(!/console\.|process\.env|setTimeout|setInterval/.test(s));
  const route = readFileSync('src/app/api/internal/ad-scheduler/route.ts', 'utf8');
  assert.deepEqual([...route.matchAll(/^export (?:async function|const) (\w+)/gm)].map((m) => m[1]).sort(), ['POST', 'dynamic', 'runtime']);
});
