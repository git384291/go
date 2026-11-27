// 코사장 11/27 광고성 전화 서버 조립 경계(OSW1~OSW6). 가짜 트랜잭션만 — 실제 DB 경로는 tests/integration/outbound-db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { CallContext, Target } from '../../src/server/outbound/compliance';
import { assembleOutbound, createOutboundService, outboundDbReady, persistenceMode } from '../../src/server/outbound/assemble';
import { ClosedMockDialer, ClosedMockLedger, ClosedMockSuppressionStore, OutboundError } from '../../src/server/outbound/providers';
import { DbOutboundLedger, DbSuppressionStore, type OutboundTx } from '../../src/server/outbound/db';

const H = (c: string) => c.repeat(64);
const target = (): Target => ({ phoneHmac: H('a'), source: { kind: 'customer_inquiry', recordId: 'lead-1', lawfulVerified: true, label: '상담 신청' }, adConsent: null, attempts: 0, lastAttemptAt: null });
const base: Omit<CallContext, 'dnc' | 'suppression' | 'now'> = {
  mode: 'live_agent', dialer: 'manual', purposeId: 'ad-internet-tv', businessId: 'bareun365',
  seller: { telemarketingRegistered: true, registrationNo: '제2026-0001호' }, disclosure: { businessName: '바른365', purpose: '안내', announcesSource: true },
  callerIdShown: true, businessNameShown: true, humanAgentReady: true, agentReserved: null,
};
const txOf = (respond: (q: string) => unknown): { tx: OutboundTx; n: () => number } => {
  let n = 0;
  return { tx: async (fn) => fn((async (s: TemplateStringsArray) => { n++; const r = respond(s.join('?')); if (r instanceof Error) throw r; return r as unknown[]; }) as never), n: () => n };
};
const closedReasons = ['INVALID_INPUT'];

test('OSW1 기본은 전부 닫힌 Mock, persistence=db는 수신거부·원장만 같은 사업자 DB 어댑터로', () => {
  const m = assembleOutbound({});
  assert.equal(m.persistence, 'mock');
  assert.ok(m.deps.suppression instanceof ClosedMockSuppressionStore && m.deps.ledger instanceof ClosedMockLedger && m.deps.dialer instanceof ClosedMockDialer);
  const d = assembleOutbound({ OUTBOUND_PERSISTENCE: 'db' }, { businessId: 'bareun365', tx: txOf(() => []).tx });
  assert.ok(d.deps.suppression instanceof DbSuppressionStore && d.deps.ledger instanceof DbOutboundLedger);
  assert.ok(d.deps.dialer instanceof ClosedMockDialer, '발신기는 DB 설정과 무관하게 Mock');
});

test('OSW2 잘못된 설정은 예외 → 서비스는 닫힘(dial 0회)', async () => {
  const bad: [Record<string, string>, Parameters<typeof assembleOutbound>[1], string][] = [
    [{ OUTBOUND_PERSISTENCE: 'db' }, {}, 'PERSISTENCE_NOT_CONFIGURED'],
    [{ OUTBOUND_PERSISTENCE: 'db' }, { businessId: 'Bad Biz', tx: txOf(() => []).tx }, 'PERSISTENCE_NOT_CONFIGURED'],
    [{ OUTBOUND_PERSISTENCE: 'supabase' }, {}, 'INVALID_CONFIG'],
    [{ OUTBOUND_DIAL_MODE: 'live' }, {}, 'LIVE_OUTBOUND_NOT_APPROVED'],
    [{ OUTBOUND_DNC_MODE: 'kisa' }, {}, 'LIVE_OUTBOUND_NOT_APPROVED'],
    [{ OUTBOUND_PERSISTENCE: 'db', OUTBOUND_DIAL_MODE: 'live' }, { businessId: 'bareun365', tx: txOf(() => []).tx }, 'LIVE_OUTBOUND_NOT_APPROVED'],
  ];
  for (const [env, o, code] of bad) {
    assert.throws(() => assembleOutbound(env, o), (e: unknown) => e instanceof OutboundError && e.code === code, JSON.stringify(env));
    const s = createOutboundService(env, o);
    assert.equal(s.persistence, 'closed');
    const r = await s.place(target(), base);
    assert.deepEqual(r.decision.reasons, closedReasons); assert.equal(r.callId, null);
  }
  assert.throws(() => persistenceMode({ OUTBOUND_PERSISTENCE: '' }), /INVALID_CONFIG/);
});

test('OSW3 DB 준비 확인: 함수 6개 실행 가능할 때만 true, 5개·오류·형태 이상은 false → 닫힘', async () => {
  assert.equal(await outboundDbReady(txOf(() => [{ n: 6 }]).tx), true);
  for (const r of [[{ n: 5 }], new Error('db down'), [], [{}], null]) assert.equal(await outboundDbReady(txOf(() => r).tx), false, JSON.stringify(r));
  const t = txOf((q) => (q.includes('unnest') ? [{ n: 5 }] : []));
  const s = createOutboundService({ OUTBOUND_PERSISTENCE: 'db' }, { businessId: 'bareun365', tx: t.tx });
  const r = await s.place(target(), base);
  assert.deepEqual(r.decision.reasons, closedReasons); assert.equal(r.callId, null);
  assert.equal(t.n(), 1, '준비 안 됨이면 수신거부·원장 쿼리 0회');
});

test('OSW4 서비스 사업자 고정: base.businessId가 다르면 닫힘(DB 호출 0회)', async () => {
  const t = txOf(() => [{ n: 6 }]);
  const s = createOutboundService({ OUTBOUND_PERSISTENCE: 'db' }, { businessId: 'bareun365', tx: t.tx });
  const r = await s.place(target(), { ...base, businessId: 'other-dealer' });
  assert.deepEqual(r.decision.reasons, closedReasons); assert.equal(t.n(), 0);
});

test('OSW5 DB 장애(준비 뒤 조회 실패)면 발신 0회', async () => {
  const t = txOf((q) => (q.includes('unnest') ? [{ n: 6 }] : new Error('connection lost')));
  const s = createOutboundService({ OUTBOUND_PERSISTENCE: 'db' }, { businessId: 'bareun365', tx: t.tx, mockDncTable: { [H('a')]: 'clear' } });
  const r = await s.place(target(), base);
  assert.equal(r.callId, null); assert.equal(r.decision.allowed, false);
});

test('OSW-BUNDLE 서버 전용 경계: 화면·공개 경로가 outbound 모듈을 import하지 않음, service.ts는 server-only, 공개 환경 값 없음', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = `${d}/${n}`; return statSync(f).isDirectory() ? walk(f) : [f]; });
  const outside = walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith('src/server/outbound/'));
  const importers = outside.filter((f) => /server\/outbound|\.\/outbound/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(importers, [], '아직 어떤 route·화면에도 연결하지 않음');
  const svc = readFileSync('src/server/outbound/service.ts', 'utf8');
  assert.match(svc.split('\n')[0], /^import 'server-only';$/);
  for (const f of walk('src/server/outbound')) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/NEXT_PUBLIC_|['"]use client['"]/.test(src), false, f);
  }
  const clientFiles = outside.filter((f) => /['"]use client['"]/.test(readFileSync(f, 'utf8')));
  for (const f of clientFiles) assert.equal(/server\/(outbound|db)/.test(readFileSync(f, 'utf8')), false, f);
});

test('OSW-ISO 교체 가능·격리: outbound 모듈은 자기 폴더·DB 배선(service.ts)만 import, 외부 연동은 인터페이스 뒤 기본 닫힘', async () => {
  const files = readdirSync('src/server/outbound').map((f) => `src/server/outbound/${f}`);
  for (const f of files) {
    const imports = [...readFileSync(f, 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const allowed = (p: string) => p.startsWith('./') || p === 'server-only' || (f.endsWith('service.ts') && p === '@/server/db/client');
    assert.deepEqual(imports.filter((p) => !allowed(p)), [], f);
  }
  const p = await import('../../src/server/outbound/providers');
  for (const sel of [p.selectDncChecker, p.selectOutboundDialer, p.selectSuppressionStore]) {
    assert.ok(sel({}) && typeof sel({}) === 'object', '기본 Mock');
    assert.throws(() => sel({ OUTBOUND_DNC_MODE: 'x', OUTBOUND_DIAL_MODE: 'x', OUTBOUND_SUPPRESSION_MODE: 'x' }), /LIVE_OUTBOUND_NOT_APPROVED/);
  }
});
