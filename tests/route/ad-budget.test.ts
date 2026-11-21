// PM 11/21: 광고 예산 통제 서버 모듈 시험. 가짜 의존성만 쓴다(DB 판정 자체는 db/tests/70·통합 시험이 확인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { adBudgetAction, adBudgetOverview, adBudgetReady, type AdBudgetDeps } from '../../src/server/admin/adBudget';
import { AD_DAILY_CAP_KRW, AD_FIRST3DAYS_CAP_KRW } from '../../src/server/advertising/budgetGuard';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const NOW = new Date('2026-11-21T03:00:00Z');
const ENV = { ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const KEY = 'req-0123456789abcdef';
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'secret-tok', role }) as StaffIdentity;
const ID = '10000000-0000-4000-8000-000000000001';

function mk(o: { env?: Record<string, string | undefined>; mode?: string; staff?: StaffIdentity | Error; tx?: (q: string) => unknown } = {}) {
  const c = { staff: 0, tx: 0, sql: [] as string[], vals: [] as unknown[][] };
  const d: AdBudgetDeps = {
    env: () => o.env ?? ENV, mode: () => (o.mode ?? 'supabase') as 'supabase',
    requireStaff: async () => { c.staff++; if (o.staff instanceof Error) throw o.staff; return o.staff ?? who('owner'); },
    runInTransaction: async (fn) => {
      c.tx++;
      const tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { const q = s.join('?'); c.sql.push(q); c.vals.push(v); const r = o.tx ? o.tx(q) : [{ id: ID, r: { decision: 'ALLOW' } }]; if (r instanceof Error) throw r; return r; }) as never;
      return fn(tag);
    },
    now: () => NOW,
  };
  return { d, c };
}
const approve = (o: Record<string, unknown> = {}) => ({ action: 'approve', campaign: 'camp-a', dailyCapKrw: 5000, totalCapKrw: 15000, hours: 24, reason: '승인 사유', ...o });
const spend = (o: Record<string, unknown> = {}) => ({ action: 'request', campaign: 'camp-a', amountKrw: 1000, requestKey: KEY, ...o });
const j = async (r: Response) => (await r.json()) as Record<string, unknown>;

test('AB1 기본 닫힘: 환경 미충족이면 인증·DB 0회 503', async () => {
  for (const env of [{}, { ADMIN_AD_SOURCE: 'mock' }, { ...ENV, NODE_ENV: 'production' }, { ...ENV, DATABASE_URL: 'postgresql://u@db.example.com/x' }]) {
    const { d, c } = mk({ env });
    assert.equal((await adBudgetOverview(d, new Request('http://x/'))).status, 503);
    assert.equal((await adBudgetAction(d, approve())).status, 503);
    const r = await adBudgetAction(d, spend());
    assert.equal(r.status, 503);
    assert.equal((await j(r)).decision, 'BLOCK'); // 지출 판정은 닫혀 있어도 허용으로 읽힐 수 없다
    assert.equal(c.staff + c.tx, 0);
  }
  assert.equal(adBudgetReady(ENV), true);
});

test('AB2 인증 실패·mock 인증·역할: 승인·철회·지출 판정은 owner만, DB 0회', async () => {
  assert.equal((await adBudgetAction(mk({ mode: 'mock' }).d, approve())).status, 503);
  assert.equal((await adBudgetAction(mk({ staff: new StaffAuthError(401, 'X') }).d, approve())).status, 401);
  for (const role of ['policy_editor', 'reviewer', 'counselor']) {
    for (const body of [approve(), { action: 'revoke', campaign: 'camp-a', reason: '철회' }, spend()]) {
      const { d, c } = mk({ staff: who(role) });
      const r = await adBudgetAction(d, body);
      assert.equal(r.status, 403, `${role} ${String(body.action)}`);
      if (body.action === 'request') assert.equal((await j(r)).decision, 'BLOCK');
      assert.equal(c.tx, 0);
    }
  }
  assert.equal((await adBudgetOverview(mk({ staff: who('reviewer') }).d, new Request('http://x/'))).status, 200);
  assert.equal((await adBudgetOverview(mk({ staff: who('counselor') }).d, new Request('http://x/'))).status, 403);
});

test('AB3 승인 입력: 상한(코드 승인 상한) 초과·형식 오류·여분 키는 DB 전에 거부', async () => {
  const bad = [
    approve({ dailyCapKrw: AD_DAILY_CAP_KRW + 1 }), approve({ totalCapKrw: AD_FIRST3DAYS_CAP_KRW + 1 }), approve({ dailyCapKrw: 6000, totalCapKrw: 5000 }),
    approve({ hours: 73 }), approve({ hours: 0 }), approve({ campaign: 'Bad Key' }), approve({ dailyCapKrw: 1.5 }), approve({ dailyCapKrw: '5000' }),
    approve({ extra: 1 }), approve({ reason: ' ' }),
  ];
  for (const b of bad) {
    const { d, c } = mk();
    assert.equal((await adBudgetAction(d, b)).status, 422, JSON.stringify(b));
    assert.equal(c.tx, 0);
  }
  const { d, c } = mk();
  const r = await adBudgetAction(d, approve());
  assert.equal(r.status, 201);
  assert.match(c.sql[0], /api\.ad_budget_approve/);
  // 만료 시각은 서버 시계로 계산한다(클라이언트가 정하지 않음)
  assert.ok(c.vals[0].includes(new Date(NOW.getTime() + 24 * 3_600_000).toISOString()));
});

test('AB4 지출 판정 입력 오류는 모두 BLOCK(DB 0회)', async () => {
  for (const b of [spend({ amountKrw: 0 }), spend({ amountKrw: AD_DAILY_CAP_KRW + 1 }), spend({ amountKrw: 10.5 }), spend({ requestKey: 'short' }), spend({ campaign: 'X Y' }), spend({ extra: 1 })]) {
    const { d, c } = mk();
    const r = await adBudgetAction(d, b);
    assert.equal(r.status, 422);
    assert.equal((await j(r)).decision, 'BLOCK');
    assert.equal(c.tx, 0);
  }
});

test('AB5 오류 시 자동 차단: DB 예외·형식 밖 응답은 BLOCK(ERROR)이며 허용으로 보이지 않음', async () => {
  for (const tx of [() => Object.assign(new Error('x'), { code: '08006' }), () => [{ r: null }], () => [{ r: { decision: 'MAYBE' } }], () => [], () => 'nope']) {
    const r = await adBudgetAction(mk({ tx }).d, spend());
    const b = await j(r);
    assert.equal(b.decision, 'BLOCK', JSON.stringify(b));
    assert.equal(b.reason, 'ERROR');
    assert.equal(b.ok, false);
    assert.ok(r.status >= 500);
  }
});

test('AB6 DB 판정 전달: ALLOW만 ok=true, BLOCK 사유(승인 없음·한도·중복)는 그대로', async () => {
  const allow = await j(await adBudgetAction(mk({ tx: () => [{ r: { decision: 'ALLOW', reason: null, spent_today: 1000 } }] }).d, spend()));
  assert.deepEqual({ ok: allow.ok, decision: allow.decision }, { ok: true, decision: 'ALLOW' });
  for (const reason of ['NO_APPROVAL', 'APPROVAL_EXPIRED', 'DAILY_CAP_EXCEEDED', 'TOTAL_CAP_EXCEEDED', 'DUPLICATE_REQUEST']) {
    const b = await j(await adBudgetAction(mk({ tx: () => [{ r: { decision: 'BLOCK', reason } }] }).d, spend()));
    assert.deepEqual({ ok: b.ok, decision: b.decision, reason: b.reason }, { ok: false, decision: 'BLOCK', reason });
  }
  // 권한 우회: DB가 42501을 내면 403 BLOCK
  const r = await adBudgetAction(mk({ tx: () => Object.assign(new Error('x'), { code: '42501' }) }).d, spend());
  assert.equal(r.status, 403);
  assert.equal((await j(r)).decision, 'BLOCK');
});

test('AB7 오류 응답은 SQL·접속정보·토큰 비노출, no-store', async () => {
  const r = await adBudgetAction(mk({ tx: () => Object.assign(new Error('connect postgres://u:p@h/db secret-tok'), { code: '08006' }) }).d, approve());
  const t = await r.text();
  assert.equal(r.status, 503);
  assert.doesNotMatch(t, /postgres:|secret-tok|select/i);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});

test('AB8 정적: SQL은 api.ad_*뿐, 외부 호출·광고 실행 코드 없음, DB 상한 = 코드 승인 상한, 화면은 서버 모듈 미import', () => {
  const root = path.resolve(__dirname, '../../src');
  const src = readFileSync(path.join(root, 'server/admin/adBudget.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const q of [...src.matchAll(/tx`([\s\S]*?)`/g)].map((m) => m[1])) {
    const fns = [...q.matchAll(/\bapi\.([a-z_]+)/g)].map((m) => m[1]);
    assert.ok(fns.length === 1 && /^ad_(budget_approve|budget_revoke|spend_request|budget_overview)$/.test(fns[0]), q.slice(0, 50));
    assert.doesNotMatch(q, /\b(core|pii|security)\.[a-z_]+/);
  }
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|https?:\/\/|searchAdStop|youtubePrivatePublisher|openAiAdGenerator|searchAdStatus/);
  const sql = readFileSync('db/migrations/0010_ad_budget.sql', 'utf8');
  assert.ok(sql.includes(`daily_cap_krw between 1 and ${AD_DAILY_CAP_KRW}`) && sql.includes(`total_cap_krw between 1 and ${AD_FIRST3DAYS_CAP_KRW}`), 'DB 상한이 코드 승인 상한과 다름');
  const client = readFileSync(path.join(root, 'app/admin/ads/AdBudgetConsole.tsx'), 'utf8');
  assert.deepEqual([...client.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]), ['react']);
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
  walk(root);
  const users = files.filter((f) => /server\/admin\/adBudget'/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
  assert.deepEqual(users, ['app/admin/ads/page.tsx', 'app/api/admin/ads/budget/route.ts']);
});
