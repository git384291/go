// PM 11/24 세션 재발급 한도 우회 공격 시험(SR1~SR10). 가짜 정책·가짜 예산·가짜 봇 확인만, 실제 AI 호출 0회.
// DB 공용 제한(consult_rate)의 실제 동시성은 scripts/ai-cost-db-concurrency.sh D21에서 실제 PostgreSQL로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInflightGuard, createLimiter, handleChat } from '../../src/server/consult/chatHandler';
import { issueSession } from '../../src/server/consult/consultSession';
import { rateKeyIp } from '../../src/server/http/clientIp';
import type { AiBudget } from '../../src/server/consult/chatModel';

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

/** DB 0028·0029·0024 판정을 흉내 낸 공용 저장소(여러 서버 인스턴스가 같이 쓴다): 사용자 일 300·전체 일 3,000, 새 세션 IP별 5·전체 60(1시간) */
function sharedDb() {
  const spent = new Map<string, number>(); let all = 0;
  const sess = new Map<string, number>(); let sessAll = 0;
  const budget: AiBudget = {
    async reserve(c, x) {
      if (!x) return null;
      const s = spent.get(x.scope) ?? 0;
      if (s + c > 300 || all + c > 3000) return null;
      spent.set(x.scope, s + c); all += c;
      return { async confirm() {}, async cancel() { spent.set(x.scope, (spent.get(x.scope) ?? 0) - c); all -= c; }, async uncertain() {} };
    },
  };
  const rateLimit = (ip: string) => async (kind: 'chat' | 'session') => {
    if (kind === 'chat') return true;
    const key = rateKeyIp(ip); // 라우트와 같은 키(아래 SR9 정적 확인)
    if (sessAll >= 60) return false;
    sessAll++;
    const n = sess.get(key) ?? 0;
    if (n >= 5) return false;
    sess.set(key, n + 1);
    return true;
  };
  return { budget, rateLimit, spent, totalSpent: () => all };
}
const model = { name: 'f', costPerCallKrw: 4, async generate(i: { approved: string }) { return `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${i.approved}`; } };
/** 서버 인스턴스 1대(메모리 제한·잠금은 인스턴스마다 따로) */
function instance(db: ReturnType<typeof sharedDb>) {
  const newSessionLimiter = createLimiter(5, 3_600_000);
  const limiter = createLimiter(100_000, 60_000);
  const inflight = createInflightGuard();
  return (ip: string, body: Record<string, unknown>, bot: () => Promise<'ok' | 'rejected' | 'unavailable'> = async () => 'ok') =>
    handleChat(new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(body) }), {
      enabled: true, chat: { provider: () => [rec], supplierId: 'supplier-a', model, budget: db.budget, failureLog: () => {} },
      limiter, ip, now: () => NOW, sessionKey: SKEY, newSessionLimiter, botCheck: bot, rateLimit: db.rateLimit(ip), inflight,
    } as never);
}
const code = async (r: Response) => { const j = await r.json() as { code?: string; session?: string }; return { status: r.status, code: j.code, session: j.session }; };

test('SR1 같은 세션 반복: 사용자 키가 그대로라 사용자 일 300원에서 멈춘다(4원 × 75회), 76번째부터 AI 예약 거부', async () => {
  const db = sharedDb(); const s = instance(db);
  const first = await code(await s('198.51.100.1', good));
  for (let i = 0; i < 80; i++) await s('198.51.100.1', { ...good, session: first.session });
  assert.equal(db.spent.size, 1);
  assert.equal([...db.spent.values()][0], 300);
});

test('SR2 세션 10회 연속 재발급(같은 IP, 토큰 버림 = 쿠키·저장소 삭제·새 브라우저와 같음): 5개 발급 뒤 SESSION_LIMIT, 사용자 키 5개', async () => {
  const db = sharedDb(); const s = instance(db);
  const r = [];
  for (let i = 0; i < 10; i++) r.push(await code(await s('198.51.100.2', good)));
  assert.equal(r.filter((x) => x.status === 200).length, 5);
  assert.deepEqual(r.slice(5).map((x) => x.code), Array(5).fill('SESSION_LIMIT'));
  assert.equal(db.spent.size, 5, '남은 위험: 발급된 5개 세션은 각자 사용자 한도(일 300원)를 가진다 → 같은 IP 1시간 최대 1,500원');
});

test('SR3 동시 세션 발급 100건(같은 IP, 서버 1대): 처리 중 잠금·IP 제한으로 5건 이하 발급, 봇 확인 실패 건은 세션 한도를 쓰지 않는다', async () => {
  const db = sharedDb(); const s = instance(db);
  const r = await Promise.all(Array.from({ length: 100 }, () => s('198.51.100.3', good).then(code)));
  assert.ok(r.filter((x) => x.status === 200).length <= 5);
  assert.ok(r.every((x) => [200, 429].includes(x.status)));
  const db2 = sharedDb(); const s2 = instance(db2);
  const bots = [];
  for (let i = 0; i < 20; i++) bots.push((await code(await s2('198.51.100.4', good, async () => 'rejected'))).code);
  // 메모리 제한(인스턴스별)은 시도 수로 세어 봇 5회 뒤 SESSION_LIMIT — 남은 위험: 같은 IP 정상 고객도 그 인스턴스에서 1시간 막힐 수 있음
  assert.deepEqual(bots, [...Array(5).fill('BOT_CHECK_FAILED'), ...Array(15).fill('SESSION_LIMIT')]);
  // 봇 실패는 DB 공용 세션 한도를 쓰지 않는다 → 다른 인스턴스에서는 정상 고객 발급 가능
  assert.equal((await code(await instance(db2)('198.51.100.4', good))).status, 200);
});

test('SR4 변조·만료·다른 키로 서명한 세션: 400 INVALID_SESSION, 예약 0건(기존 CH12와 같은 판정, 공격 목록 확인용 1회)', async () => {
  const db = sharedDb(); const s = instance(db);
  const t = issueSession(SKEY, Math.floor(NOW.getTime() / 1000)).token;
  const flip = t.slice(0, -1) + (t.at(-1) === '0' ? '1' : '0');
  const expired = issueSession(SKEY, Math.floor(NOW.getTime() / 1000) - 25 * 3600).token;
  const other = issueSession(Buffer.alloc(32, 9), Math.floor(NOW.getTime() / 1000)).token;
  for (const bad of [flip, expired, other, 'a'.repeat(32), `${'a'.repeat(32)}.9999999999.${'0'.repeat(64)}`]) {
    assert.deepEqual(await code(await s('198.51.100.5', { ...good, session: bad })), { status: 400, code: 'INVALID_SESSION', session: undefined });
  }
  assert.equal(db.spent.size, 0);
});

test('SR5 서로 다른 IPv4에서 재발급: IP마다 5개씩 발급되지만 DB 전체 새 세션 60개/시간·전체 AI 일 3,000원에서 멈춘다(남은 위험)', async () => {
  const db = sharedDb(); const s = instance(db);
  let ok = 0;
  for (let i = 1; i <= 20; i++) for (let j = 0; j < 5; j++) if ((await code(await s(`203.0.113.${i}`, good))).status === 200) ok++;
  assert.equal(ok, 60, 'IP 20개 × 5 = 100 시도 → DB 전체 상한 60');
  assert.ok(db.totalSpent() <= 3000);
});

test('SR6 같은 IP(NAT·와이파이)의 서로 다른 정상 고객: 사용자 키가 달라 한 사람이 300원을 다 써도 다른 고객은 계속 상담', async () => {
  const db = sharedDb(); const s = instance(db);
  const a = (await code(await s('192.0.2.10', good))).session!;
  const b = (await code(await s('192.0.2.10', good))).session!;
  for (let i = 0; i < 80; i++) await s('192.0.2.10', { ...good, session: a });
  const before = db.totalSpent();
  await s('192.0.2.10', { ...good, session: b });
  assert.equal(db.totalSpent(), before + 4, 'B는 A의 한도와 무관');
  assert.equal(db.spent.size, 2);
});

test('SR7 IPv6 같은 /64 안에서 주소만 바꿔 재발급: 한 회선으로 묶여 5개 뒤 SESSION_LIMIT(수정 전: 주소마다 5개 → 제한 무력화)', async () => {
  const db = sharedDb(); const s = instance(db);
  const r = [];
  for (let i = 1; i <= 10; i++) r.push((await code(await s(`2001:db8:aa:bb::${i.toString(16)}`, good))).status);
  assert.equal(r.filter((x) => x === 200).length, 5);
  // 표기만 다른 같은 주소·대소문자도 같은 키
  for (const v of ['2001:db8:aa:bb::1', '2001:0DB8:00AA:00bb:0:0:0:1', '2001:db8:aa:bb:0::1', '2001:db8:aa:bb:ffff:1:2:3']) assert.equal(rateKeyIp(v), '2001:db8:aa:bb::/64', v);
  assert.notEqual(rateKeyIp('2001:db8:aa:bc::1'), rateKeyIp('2001:db8:aa:bb::1'), '다른 /64는 다른 회선');
  assert.equal(rateKeyIp('::ffff:c000:20a'), '192.0.2.10', 'IPv4 대응 IPv6 = 그 IPv4');
  assert.equal(rateKeyIp('203.0.113.7'), '203.0.113.7');
  for (const bad of ['', 'x', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::1', '::ffff:1.2.3.4', '0.0.0.0']) assert.equal(rateKeyIp(bad), '0.0.0.0', bad);
});

test('SR8 여러 서버 인스턴스 발급(같은 IP, 4대 × 25건 동시 + 순차 10건): 메모리 제한은 인스턴스마다 따로지만 DB 공용 제한으로 합계 5개', async () => {
  const db = sharedDb();
  const servers = [instance(db), instance(db), instance(db), instance(db)];
  const r = await Promise.all(servers.flatMap((s) => Array.from({ length: 25 }, () => s('198.51.100.8', good).then(code))));
  const first = r.filter((x) => x.status === 200).length;
  assert.ok(first >= 1 && first <= 5, String(first));
  // 이어서 인스턴스를 돌아가며 순차 10회 더 → 합계는 DB 상한 5개를 넘지 않는다
  let more = 0;
  for (let i = 0; i < 10; i++) if ((await code(await servers[i % 4]!('198.51.100.8', good))).status === 200) more++;
  assert.equal(first + more, 5);
});

test('SR9 정적: 라우트 DB 제한 키 = rateKeyIp(IP)의 HMAC, 핸들러 메모리 제한·잠금도 같은 키, 세션 토큰·IP·고객 글을 로그로 남기지 않는다', () => {
  const route = readFileSync('src/app/api/consult/chat/route.ts', 'utf8');
  assert.match(route, /ipHash\(rateKeyIp\(ip\)\)/);
  const h = readFileSync('src/server/consult/chatHandler.ts', 'utf8');
  assert.match(h, /const net = rateKeyIp\(d\.ip\);/);
  assert.match(h, /d\.limiter\(net,/);
  assert.match(h, /d\.newSessionLimiter\(net,/);
  assert.match(h, /key = `i:\$\{net\}`/);
  for (const f of ['src/app/api/consult/chat/route.ts', 'src/server/consult/chatHandler.ts', 'src/server/consult/consultSession.ts', 'src/server/http/clientIp.ts', 'src/server/leads/turnstile.ts']) {
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(readFileSync(f, 'utf8')), `${f}: 로그 출력 없음`);
  }
});

test('SR10 한도 확인 실패는 막는다(fail-closed): 봇 확인 장애 503, DB 세션 제한 장애 503, 세션 발급 0', async () => {
  const db = sharedDb();
  const s = instance(db);
  assert.equal((await code(await s('198.51.100.10', good, async () => 'unavailable'))).status, 503);
  const broken = handleChat(new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(good) }), {
    enabled: true, chat: { provider: () => [rec], supplierId: 'supplier-a', model, budget: db.budget, failureLog: () => {} },
    limiter: createLimiter(100, 60_000), ip: '198.51.100.11', now: () => NOW, sessionKey: SKEY, newSessionLimiter: createLimiter(5, 3_600_000), botCheck: async () => 'ok',
    rateLimit: async () => { throw new Error('db down'); }, inflight: createInflightGuard(),
  } as never);
  const r = await code(await broken);
  assert.deepEqual([r.status, r.code, r.session], [503, 'RATE_CHECK_UNAVAILABLE', undefined]);
  assert.equal(db.spent.size, 0);
});
