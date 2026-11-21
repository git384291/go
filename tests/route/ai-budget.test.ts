// PM 11/21: 관리자 AI 월 비용 한도 서버 모듈 시험(가짜 의존성). 한도 판정·감사는 DB 시험(95)·통합 시험이 확인
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiBudgetGet, aiBudgetSet } from '../../src/server/admin/aiBudget';
import type { AdBudgetDeps } from '../../src/server/admin/adBudget';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const ENV = { ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'secret-tok', role }) as StaffIdentity;
const ROW = { month: '2026-11', monthly_limit_krw: 0, used_krw: 0, unconfirmed_count: 0 };
function mk(o: { env?: Record<string, string | undefined>; staff?: StaffIdentity | Error; tx?: (q: string) => unknown } = {}) {
  const c = { staff: 0, tx: 0, sql: [] as string[], vals: [] as unknown[][] };
  const d: AdBudgetDeps = {
    env: () => o.env ?? ENV, mode: () => 'supabase',
    requireStaff: async () => { c.staff++; if (o.staff instanceof Error) throw o.staff; return o.staff ?? who('owner'); },
    runInTransaction: async (fn) => { c.tx++; const tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { const q = s.join('?'); c.sql.push(q); c.vals.push(v); const r = o.tx ? o.tx(q) : [ROW]; if (r instanceof Error) throw r; return r; }) as never; return fn(tag); },
    now: () => new Date('2026-11-21T03:00:00Z'),
  };
  return { d, c };
}
const j = async (r: Response) => (await r.json()) as Record<string, unknown>;
const body = (o: Record<string, unknown> = {}) => ({ limitKrw: 5000, reason: '개발용 모의 시험', ...o });

test('AI1 기본 닫힘·권한: 환경 미충족 503, 조회는 대표·검토자, 설정은 대표만, 거부 시 DB 0회', async () => {
  for (const env of [{}, { ADMIN_AD_SOURCE: 'mock' }, { ...ENV, NODE_ENV: 'production' }]) {
    const { d, c } = mk({ env });
    assert.equal((await aiBudgetGet(d)).status, 503); assert.equal((await aiBudgetSet(d, body())).status, 503);
    assert.equal(c.staff + c.tx, 0);
  }
  for (const role of ['reviewer']) assert.equal((await aiBudgetGet(mk({ staff: who(role) }).d)).status, 200);
  for (const role of ['reviewer', 'policy_editor', 'counselor']) { const { d, c } = mk({ staff: who(role) }); assert.equal((await aiBudgetSet(d, body())).status, 403); assert.equal(c.tx, 0); }
  for (const role of ['policy_editor', 'counselor']) assert.equal((await aiBudgetGet(mk({ staff: who(role) }).d)).status, 403);
  assert.equal((await aiBudgetGet(mk({ staff: new StaffAuthError(401, 'X') }).d)).status, 401);
});
test('AI2 조회: 월·한도·사용액·미확정 건수를 정수 검사 후 반환, 이상한 DB 값은 502', async () => {
  const r = await aiBudgetGet(mk({ tx: () => [{ month: '2026-11', monthly_limit_krw: 5000, used_krw: 120, unconfirmed_count: 2 }] }).d);
  const b = await j(r);
  assert.deepEqual([r.status, b.limitKrw, b.usedKrw, b.unconfirmed, b.maxLimitKrw], [200, 5000, 120, 2, 100000]);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  for (const bad of [[], [{ ...ROW, monthly_limit_krw: -1 }], [{ ...ROW, used_krw: 1.5 }], [{ ...ROW, month: '2026-1' }], [{ ...ROW, unconfirmed_count: '3' }]]) assert.equal((await aiBudgetGet(mk({ tx: () => bad }).d)).status, 502);
});
test('AI3 설정 입력: 정확한 키·0~100000 정수·사유 필수. 불량은 DB 0회', async () => {
  for (const bad of [{ limitKrw: 5000 }, { ...body(), extra: 1 }, null, [], 'x']) { const { d, c } = mk(); assert.equal((await aiBudgetSet(d, bad)).status, 422); assert.equal(c.tx, 0); }
  for (const v of [-1, 100001, 1.5, '5000', null, NaN, Infinity]) { const { d, c } = mk(); const r = await aiBudgetSet(d, body({ limitKrw: v })); assert.deepEqual([r.status, (await j(r)).code], [422, 'INVALID_LIMIT']); assert.equal(c.tx, 0); }
  for (const v of ['', ' ', 'a', 'x'.repeat(501), 5, null]) { const { d, c } = mk(); const r = await aiBudgetSet(d, body({ reason: v })); assert.deepEqual([r.status, (await j(r)).code], [422, 'REASON_REQUIRED']); assert.equal(c.tx, 0); }
});
test('AI4 설정 성공: ai_budget_limit_set 1회, 값은 바인딩(문자열 이어붙임 없음), 0원·상한값 허용', async () => {
  for (const v of [0, 100000]) {
    const { d, c } = mk({ tx: () => [{}] });
    assert.equal((await aiBudgetSet(d, body({ limitKrw: v }))).status, 200);
    assert.equal(c.sql.length, 1); assert.match(c.sql[0], /api\.ai_budget_limit_set/); assert.ok(c.vals[0].includes(v));
    assert.ok(!c.sql[0].includes(String(v)) || v === 0 ? true : false);
  }
});
test('AI5 DB 오류는 안전하게 변환: 권한 403, 알려진 22023 422, 그 밖 503, 원문·비밀 노출 없음', async () => {
  for (const [code, msg, st] of [['42501', 'secret perm', 403], ['22023', 'INVALID_LIMIT', 422], ['XX000', 'host=10.0.0.1 secret', 503]] as const) {
    const r = await aiBudgetSet(mk({ tx: () => Object.assign(new Error(msg), { code }) }).d, body());
    assert.equal(r.status, st); assert.ok(!JSON.stringify(await j(r)).includes('secret'));
  }
});
test('AI6 정적: AI 한도 모듈·화면은 외부 호출·실제 AI 주소·키 없음, 화면은 서버 모듈 미import', () => {
  for (const f of ['src/server/admin/aiBudget.ts', 'src/app/api/admin/ai/budget/route.ts', 'src/app/admin/ai-budget/page.tsx', 'src/app/admin/ai-budget/AiBudgetView.tsx', 'src/app/admin/ai-budget/AiBudgetConsole.tsx']) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/fetch\(\s*['"`]https?:|api\.openai\.com|api\.anthropic\.com|API_KEY/.test(s), f);
  }
  for (const f of ['src/app/admin/ai-budget/AiBudgetView.tsx', 'src/app/admin/ai-budget/AiBudgetConsole.tsx']) assert.ok(!/server\/(admin|consult|db)/.test(readFileSync(f, 'utf8')), f);
});
