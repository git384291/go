// 사용자별 AI 한도 우회 검증(PM 11/24): 세션 재발급(쿠키 삭제)·IPv6 주소 바꾸기·서버 여러 대. 실제 AI 호출 0회.
// 실DB 동시성 검증은 scripts/ai-scope-bypass-db.sh(SB-D*). 여기서는 핸들러·라우트 배선을 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rateLimitIpKey } from '../../src/server/http/clientIp';
import { createAiBudget, type AiBudget, type ReserveContext } from '../../src/server/consult/chatModel';
import { createInflightGuard, createLimiter, handleChat } from '../../src/server/consult/chatHandler';

test('SB1 횟수 제한 키: IPv4 그대로, IPv6는 /64로 묶음(표기 달라도 같은 키), 해석 불가 IPv6는 공용 버킷', () => {
  assert.equal(rateLimitIpKey('203.0.113.9'), '203.0.113.9');
  const k = rateLimitIpKey('2001:db8:1:2::1');
  assert.equal(k, '2001:db8:1:2::/64');
  for (const v of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0DB8:0001:0002:aaaa::9', '2001:db8:1:2:0:0:0:0']) assert.equal(rateLimitIpKey(v), k, v);
  assert.notEqual(rateLimitIpKey('2001:db8:1:3::1'), k, '다른 /64는 다른 키');
  for (const bad of ['1::2::3', 'fe80:1:2:3:4:5:6:7:8', '1:2:3', 'zz::1']) assert.equal(rateLimitIpKey(bad), '0.0.0.0', bad);
});

// 라우트와 같은 배선: DB 공용 한도(0024 규칙: IP 키별 새 세션 1시간 5개)는 라우트 클로저가 rateLimitIpKey(ip)로 센다
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
const post = (b: unknown) => new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify(b) });

function sharedDb() { // DB 한 곳(서버 여러 대가 공유): 0024와 같은 IP별 새 세션 5개
  const hits = new Map<string, number>();
  return (key: string, kind: 'chat' | 'session') => { const b = `${kind}:${key}`; const n = hits.get(b) ?? 0; if (kind === 'session' && n >= 5) return false; hits.set(b, n + 1); return true; };
}
function server(db: ReturnType<typeof sharedDb>, scopes: string[], botIps: string[]) { // 서버 인스턴스 1대: 메모리 제한·동시 처리 표시는 인스턴스마다 따로
  const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100000' });
  const budget: AiBudget = { async reserve(c, ctx?: ReserveContext) { if (ctx) scopes.push(ctx.scope); return inner.reserve(c, ctx); } };
  const model = { name: 'f', costPerCallKrw: 1, async generate(i: { approved: string }) { return `문의 주셔서 감사합니다. 현재 확인된 안내입니다.\n${i.approved}`; } };
  const limiter = createLimiter(1000, 60_000); const newSessionLimiter = createLimiter(5, 3_600_000); const inflight = createInflightGuard();
  return (ip: string, body: unknown) => handleChat(post(body), {
    enabled: true, chat: { provider: () => [rec], supplierId: 'supplier-a', model, budget, failureLog: () => {} },
    limiter, newSessionLimiter, inflight, ip, now: () => NOW, sessionKey: SKEY,
    botCheck: async (_t: string, from: string) => { botIps.push(from); return 'ok'; },
    rateLimit: async (kind: 'chat' | 'session') => db(rateLimitIpKey(ip), kind),
  } as never);
}

test('SB2 쿠키 삭제 + IPv6 주소 바꾸기 + 서버 2대 번갈아: 새 세션(= 새 사용자 키)은 /64당 5개까지만', async () => {
  const db = sharedDb(); const scopes: string[] = []; const botIps: string[] = [];
  const A = server(db, scopes, botIps), B = server(db, scopes, botIps);
  const codes: number[] = [];
  for (let i = 1; i <= 20; i++) { // 매번 세션 없이(쿠키 삭제), 같은 /64 안의 다른 주소, 서버 번갈아
    const ip = `2001:db8:1:2::${i.toString(16)}`;
    codes.push((await (i % 2 ? A : B)(ip, good)).status);
  }
  assert.equal(codes.filter((c) => c === 200).length, 5, '수정 전에는 주소마다 새 버킷이라 20개 모두 발급(우회)');
  assert.equal(codes.filter((c) => c === 429).length, 15);
  assert.equal(new Set(scopes).size, 5, '사용자 키(AI 한도)도 5개뿐');
  assert.ok(botIps.includes('2001:db8:1:2::1'), '봇 확인에는 원래 IP를 그대로 넘긴다');
});

test('SB3 서버 2대 = 메모리 제한 2배여도 DB 공용 한도가 최종: IPv4 한 주소 새 세션 5개', async () => {
  const db = sharedDb(); const scopes: string[] = [];
  const A = server(db, scopes, []), B = server(db, scopes, []);
  let ok = 0;
  for (let i = 0; i < 12; i++) if ((await (i % 2 ? A : B)('203.0.113.9', good)).status === 200) ok++;
  assert.equal(ok, 5);
});

test('SB4 같은 세션은 서버가 달라도 같은 사용자 키(세션 토큰을 다른 서버로 보내도 한도 분리 안 됨)', async () => {
  const db = sharedDb(); const scopes: string[] = [];
  const A = server(db, scopes, []), B = server(db, scopes, []);
  const s = (await (await A('203.0.113.9', good)).json() as { session: string }).session;
  assert.equal((await B('198.51.100.7', { ...good, session: s })).status, 200);
  assert.equal(scopes.length, 2);
  assert.equal(scopes[0], scopes[1]);
});

test('SB5 라우트 배선(정적): DB 횟수 제한 해시는 rateLimitIpKey(ip), 핸들러 메모리 제한·새 세션 제한도 같은 키', () => {
  const route = readFileSync('src/app/api/consult/chat/route.ts', 'utf8');
  assert.match(route, /\.ipHash\(rateLimitIpKey\(ip\)\)/);
  const h = readFileSync('src/server/consult/chatHandler.ts', 'utf8');
  assert.match(h, /const rip = rateLimitIpKey\(d\.ip\)/);
  assert.match(h, /d\.limiter\(rip,/);
  assert.match(h, /d\.newSessionLimiter\(rip,/);
  assert.match(h, /d\.botCheck\([^)]*, d\.ip\)/);
});
