// PM 11/24 회선별 하루 300원(0032) — 앱 배선·정상 고객 영향. DB 원자성·동시성은 scripts/ai-scope-bypass-db.sh SB-D6. 실제 AI 호출 0회.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rateLimitIpKey } from '../../src/server/http/clientIp';
import { createDbAiBudget, type AiBudget, type ReserveContext } from '../../src/server/consult/chatModel';
import { aiNetFor, aiScopeFor, createInflightGuard, createLimiter, handleChat } from '../../src/server/consult/chatHandler';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';

const NOW = new Date('2026-11-23T12:00:00+09:00');
const K = <T,>(value: T) => ({ known: true as const, value });
const rec = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved', confirmedAt: '2026-11-23T09:00:00+09:00', validFrom: '2026-11-23T00:00:00+09:00', validUntil: K('2026-11-24T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36), equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([]), regionScope: K('nationwide'),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
};
const SKEY = Buffer.alloc(32, 7);
const good = { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?' };
const model = { name: 'f', costPerCallKrw: 4, async generate(i: { approved: string }) { return `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${i.approved}`; } };

/** DB 0032 판정 흉내(서버 여러 대가 공유): 회선 하루 300원, 사용자 하루 300원 */
function sharedBudget() {
  const net = new Map<string, number>(); const user = new Map<string, number>(); const ctxs: ReserveContext[] = [];
  const budget: AiBudget = {
    async reserve(c, x) {
      if (!x || !x.net) return null; // 상담 경로는 회선 키 필수
      ctxs.push(x);
      const n = net.get(x.net) ?? 0; const u = user.get(x.scope) ?? 0;
      if (n + c > 300 || u + c > 300) return null;
      net.set(x.net, n + c); user.set(x.scope, u + c);
      return { async confirm() {}, async cancel() { net.set(x.net!, (net.get(x.net!) ?? 0) - c); user.set(x.scope, (user.get(x.scope) ?? 0) - c); }, async uncertain() {} };
    },
  };
  return { budget, net, user, ctxs };
}
function server(db: ReturnType<typeof sharedBudget>) {
  const newSessionLimiter = createLimiter(1000, 3_600_000); const limiter = createLimiter(100_000, 60_000); const inflight = createInflightGuard();
  return async (ip: string, body: Record<string, unknown>) => {
    const r = await handleChat(new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(body) }), {
      enabled: true, chat: { provider: () => [rec], supplierId: 'supplier-a', model, budget: db.budget, failureLog: () => {} },
      limiter, ip, now: () => NOW, sessionKey: SKEY, newSessionLimiter, botCheck: async () => 'ok', rateLimit: async () => true, inflight,
    } as never);
    return { status: r.status, body: await r.json() as { ok?: boolean; source?: string; next?: string; text?: string; session?: string } };
  };
}

test('NC1 회선 키: 같은 /64·같은 IPv4는 세션이 달라도 같은 키, 다른 회선은 다른 키, IPv4 대응 IPv6 = 그 IPv4, 원문 IP·IP 해시와 다름', () => {
  const a = aiNetFor(SKEY, '2001:db8:aa:bb::1');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(aiNetFor(SKEY, '2001:db8:aa:bb:ffff:1:2:3'), a);
  assert.notEqual(aiNetFor(SKEY, '2001:db8:aa:bc::1'), a);
  assert.equal(aiNetFor(SKEY, '::ffff:c000:20a'), aiNetFor(SKEY, '192.0.2.10'));
  assert.equal(rateLimitIpKey('::ffff:c000:20a'), '192.0.2.10', 'PR #13에서 반영: 대응 주소를 한 버킷(0:0:0:0::/64)으로 몰지 않음');
  assert.notEqual(aiNetFor(SKEY, '192.0.2.10'), aiNetFor(SKEY, '192.0.2.11'));
  assert.notEqual(aiNetFor(SKEY, '192.0.2.10'), aiNetFor(Buffer.alloc(32, 8), '192.0.2.10'), '서버 키 없이는 추측 불가');
  const ipHash = createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: SKEY }).ipHash('192.0.2.10');
  assert.ok(![ipHash, '192.0.2.10'].includes(aiNetFor(SKEY, '192.0.2.10')));
  assert.notEqual(aiNetFor(SKEY, 'x'), aiScopeFor(SKEY, 'x'), '용도 구분(사용자 키와 섞이지 않음)');
});

test('NC2 세션 10회 재발급(같은 와이파이): 사용자 키는 매번 새것이지만 회선 키가 같아 합계 300원(4원 × 75회)에서 멈춘다, 다른 회선은 영향 없음', async () => {
  const db = sharedBudget(); const s = server(db);
  for (let i = 0; i < 10; i++) {
    const first = await s('198.51.100.20', good);
    for (let j = 0; j < 9; j++) await s('198.51.100.20', { ...good, session: first.body.session });
  }
  assert.equal(new Set(db.ctxs.map((c) => c.scope)).size, 10);
  assert.equal(db.net.size, 1);
  assert.equal([...db.net.values()][0], 300);
  const other = await s('198.51.100.21', good);
  assert.equal(other.body.source, 'model');
});

test('NC3 회선 한도 초과 = 같은 와이파이의 정상 고객도 AI 답변 대신 안전 안내 + 상담 신청 경로(next signup), 세션·개인정보는 섞이지 않음', async () => {
  const db = sharedBudget(); const s = server(db);
  const a = await s('192.0.2.50', good);
  for (let i = 0; i < 80; i++) await s('192.0.2.50', { ...good, session: a.body.session, message: '010-1234-5678 요금?' });
  const b = await s('192.0.2.50', good);
  assert.equal(b.status, 200);
  assert.equal(b.body.source, 'fallback');
  assert.equal(b.body.next, 'signup', '사람 상담 연결(신청) 경로 유지');
  assert.notEqual(b.body.session, a.body.session, '세션은 고객마다 따로');
  assert.ok(!JSON.stringify(b.body).includes('1234-5678'), '다른 고객 글이 섞이지 않음');
  // A 세션은 여전히 유효(만료·무효화 없음) — 다른 고객이 새 세션을 받아도 A 토큰은 그대로 통과
  const again = await s('192.0.2.50', { ...good, session: a.body.session });
  assert.equal(again.status, 200);
});

test('NC4 DB 예산: 회선 키가 있으면 4인자 예약, 형식이 틀리면 DB 호출 없이 거부(fail-closed), 없으면(광고 등 내부 경로) 기존 3인자', async () => {
  const sql: string[] = [];
  const b = createDbAiBudget(async (fn) => fn(((s: TemplateStringsArray, ...v: unknown[]) => { sql.push(`${s.join('?')}|${v.length}`); return Promise.resolve(s.join('?').includes('hold') ? [{ id: '7' }] : [{}]); }) as never));
  const base = { requestId: 'req-net-000000000001', scope: 'a'.repeat(64) };
  assert.ok(await b.reserve(4, { ...base, net: 'b'.repeat(64) }));
  assert.match(sql.at(-1)!, /ai_budget_hold\(\?::int, \?::text, \?::text, \?::text\)/);
  sql.length = 0;
  assert.equal(await b.reserve(4, { ...base, net: 'not-a-hash' }), null);
  assert.equal(sql.length, 0);
  assert.ok(await b.reserve(4, base));
  assert.match(sql.at(-1)!, /ai_budget_hold\(\?::int, \?::text, \?::text\)::text/);
});

test('NC5 정적: 상담 핸들러는 회선 키를 늘 넣는다(없으면 예약 문맥 없음 = DB 거부), 회선 키는 서버 키 HMAC, 로그 출력 없음', () => {
  const h = readFileSync('src/server/consult/chatHandler.ts', 'utf8');
  assert.match(h, /const net = aiNetFor\(d\.sessionKey as Buffer, d\.ip\);/);
  assert.match(h, /SCOPE_KEY\.test\(scope\) && SCOPE_KEY\.test\(net\) \? \{ requestId: [^}]+, scope, net \} : undefined/);
  assert.ok(!/console\./.test(h));
  const mig = readFileSync('db/migrations/0032_ai_net_daily_cap.sql', 'utf8');
  assert.match(mig, /net_daily_limit_krw int not null default 300/);
  assert.match(mig, /\+ p_cost > c\.net_daily_limit_krw then\s+return null;/);
});
