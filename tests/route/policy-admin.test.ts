// PM 11/21: 관리자 정책 업로드·검증·승인·게시 서버 모듈 시험. 가짜 의존성만 쓴다(실제 DB·Auth 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyDraft, listPolicies, parseUpload, policyAction, policyAdminReady, validateUpload, type PolicyAdminDeps } from '../../src/server/admin/policyAdmin';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const ID = '10000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-21T03:00:00Z');
const READY_ENV = { ADMIN_POLICY_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'tok', role }) as StaffIdentity;

function mk(o: { env?: Record<string, string | undefined>; mode?: string; staff?: StaffIdentity | Error; tx?: (sql: string) => unknown } = {}) {
  const c = { staff: 0, tx: 0, sql: [] as string[] };
  const d: PolicyAdminDeps = {
    env: () => o.env ?? READY_ENV,
    mode: () => (o.mode ?? 'supabase') as 'supabase',
    requireStaff: async () => { c.staff++; if (o.staff instanceof Error) throw o.staff; return o.staff ?? who('owner'); },
    runInTransaction: async (fn) => {
      c.tx++;
      const tag = (async (s: TemplateStringsArray) => { const q = s.join('?'); c.sql.push(q); const r = o.tx ? o.tx(q) : [{ id: ID }]; if (r instanceof Error) throw r; return r; }) as never;
      return fn(tag);
    },
    now: () => NOW,
  };
  return { d, c };
}
const known = (value: unknown) => ({ known: true, value });
const krw = (n: number) => known({ amountKrw: n, vat: 'included' });
const upload = (over: Record<string, unknown> = {}) => ({
  supplierId: 's1', segment: 'household', carrier: 'kt', productId: 'p1', category: 'internet_tv', sourceKind: 'official_policy_sheet',
  confirmedAt: '2026-11-21T00:00:00+09:00', validFrom: '2026-11-21T00:00:00+09:00', validUntil: '2026-12-31T00:00:00+09:00', productLabel: '인터넷+TV',
  terms: {
    monthlyFee: krw(30000), contractMonths: known(36), equipmentMonthlyFee: krw(0), installFee: krw(0), bundlePrerequisites: known([]), regionScope: known('nationwide'),
    customerBenefit: known({ amountKrw: 0, form: 'none', payoutCondition: { known: false }, cancellationCondition: { known: false } }),
  },
  ...over,
});

test('PA1 닫힘 기본: 환경 미충족이면 인증·DB 0회 503', async () => {
  for (const env of [{}, { ADMIN_POLICY_SOURCE: 'mock' }, { ...READY_ENV, NODE_ENV: 'production' }, { ...READY_ENV, DATABASE_URL: 'postgresql://u@db.example.com/x' }]) {
    const { d, c } = mk({ env });
    const r = await listPolicies(d, new Request('http://x/api/admin/policies'));
    assert.equal(r.status, 503);
    assert.equal(c.staff + c.tx, 0);
  }
  assert.equal(policyAdminReady(READY_ENV), true);
});

test('PA2 mock 인증 모드·미인증·권한 없음', async () => {
  assert.equal((await listPolicies(mk({ mode: 'mock' }).d, new Request('http://x/'))).status, 503);
  assert.equal((await listPolicies(mk({ staff: new StaffAuthError(401, 'UNAUTHENTICATED') }).d, new Request('http://x/'))).status, 401);
  assert.equal((await listPolicies(mk({ staff: new StaffAuthError(403, 'X') }).d, new Request('http://x/'))).status, 403);
  assert.equal((await listPolicies(mk({ staff: new Error('boom') }).d, new Request('http://x/'))).status, 503);
});

test('PA3 역할 선검사: 승인·반려는 owner만, DB 0회', async () => {
  for (const role of ['policy_editor', 'reviewer', 'counselor']) {
    for (const action of ['approve', 'reject']) {
      const { d, c } = mk({ staff: who(role) });
      const r = await policyAction(d, ID, { action, reason: '확인 완료', checks: { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true } });
      assert.equal(r.status, 403, `${role} ${action}`);
      assert.equal(c.tx, 0);
    }
  }
  const { d, c } = mk({ staff: who('counselor') });
  assert.equal((await createPolicyDraft(d, upload())).status, 403);
  assert.equal((await listPolicies(d, new Request('http://x/'))).status, 403);
  assert.equal(c.tx, 0);
  assert.equal((await policyAction(mk({ staff: who('reviewer') }).d, ID, { action: 'submit' })).status, 403);
  assert.equal((await listPolicies(mk({ staff: who('reviewer') }).d, new Request('http://x/'))).status, 200);
});

test('PA4 승인: 5개 확인 항목 모두 true·사유 필수·여분 키 거부', async () => {
  const all = { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true };
  const bad = [
    { action: 'approve', reason: '확인 완료' },
    { action: 'approve', reason: '확인 완료', checks: { ...all, vat: false } },
    { action: 'approve', reason: '확인 완료', checks: { ...all, extra: true } },
    { action: 'approve', reason: '확인 완료', checks: { source_matched: true } },
    { action: 'approve', reason: '확인 완료', checks: { ...all, vat: 'true' } },
  ];
  for (const b of bad) {
    const { d, c } = mk();
    assert.equal((await policyAction(d, ID, b)).status, 422);
    assert.equal(c.tx, 0);
  }
  assert.equal((await policyAction(mk().d, ID, { action: 'approve', reason: ' ', checks: all })).status, 422);
  const { d, c } = mk({ tx: () => [{}] });
  const r = await policyAction(d, ID, { action: 'approve', reason: '확인 완료', checks: all });
  assert.equal(r.status, 200);
  assert.match(c.sql[0], /api\.policy_approve/);
  assert.equal((await policyAction(mk().d, 'not-a-uuid', { action: 'reject', reason: '사유' })).status, 400);
  assert.equal((await policyAction(mk().d, ID, { action: 'delete' })).status, 400);
});

test('PA5 업로드 검증: 엄격한 스키마', () => {
  assert.ok(parseUpload(upload()));
  assert.equal(parseUpload(upload({ commissionKrw: 1 })), null);
  assert.equal(parseUpload(upload({ segment: 'vip' })), null);
  assert.equal(parseUpload(upload({ sourceKind: 'x' })), null);
  assert.equal(parseUpload(upload({ confirmedAt: '2026-11-21' })), null);
  assert.equal(parseUpload(upload({ terms: { monthlyFee: krw(1) } })), null);
  assert.equal(parseUpload(null), null);
  assert.equal(parseUpload(upload({ dryRun: 'yes' })), null);
});

test('PA6 dryRun: DB 0회, 견적 규칙으로 사유 반환', async () => {
  const { d, c } = mk();
  const ok = await createPolicyDraft(d, upload({ dryRun: true }));
  const b = (await ok.json()) as { dryRun: boolean; quotable: boolean; reasons: string[] };
  assert.equal(ok.status, 200);
  assert.equal(b.dryRun, true);
  assert.equal(c.tx, 0);
  assert.equal(b.quotable, true, JSON.stringify(b));
  const u = parseUpload(upload({ sourceKind: 'training_material' }))!;
  const v = validateUpload(u, NOW);
  assert.equal(v.quotable, false);
  assert.ok(v.reasons.includes('SOURCE_NOT_QUOTABLE'));
  const u2 = parseUpload(upload({ terms: { ...upload().terms, monthlyFee: { known: false } } }))!;
  assert.ok(validateUpload(u2, NOW).reasons.includes('MONTHLY_FEE_UNKNOWN'));
});

test('PA7 초안 저장: DB 함수 호출·201·id 반환, 수수료 인자 없음', async () => {
  const { d, c } = mk();
  const r = await createPolicyDraft(d, upload());
  assert.equal(r.status, 201);
  assert.equal(((await r.json()) as { id: string }).id, ID);
  assert.match(c.sql[0], /api\.policy_create_draft/);
  assert.doesNotMatch(c.sql[0], /commission|settlement/i);
});

test('PA8 DB 오류 매핑: SQL 문구·접속정보 비노출', async () => {
  const cases: [Record<string, unknown>, number, string][] = [
    [{ code: '42501', message: 'permission denied for secret_table' }, 403, 'FORBIDDEN'],
    [{ code: '22023', message: 'CHECKS_REQUIRED' }, 422, 'CHECKS_REQUIRED'],
    [{ code: '22023', message: 'weird sql text postgres://u:p@h' }, 422, 'INVALID_INPUT'],
    [{ code: 'FP001', message: 'x' }, 409, 'PRODUCT_NOT_ACTIVE'],
    [{ code: '23514', message: 'x' }, 422, 'INVALID_TERMS'],
    [{ code: '08006', message: 'connect postgres://u:p@h/db failed' }, 503, 'DB_UNAVAILABLE'],
  ];
  for (const [e, st, code] of cases) {
    const { d } = mk({ tx: () => Object.assign(new Error(String(e.message)), e) });
    const r = await createPolicyDraft(d, upload());
    const t = await r.text();
    assert.equal(r.status, st);
    assert.equal((JSON.parse(t) as { code: string }).code, code);
    assert.doesNotMatch(t, /postgres:|secret_table|weird sql/);
  }
});

test('PA9 목록: 페이지 검증·no-store·토큰 비노출', async () => {
  const { d, c } = mk({ tx: () => [{ id: ID, state: 'draft' }] });
  const r = await listPolicies(d, new Request('http://x/api/admin/policies?limit=10&offset=0'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(await r.text(), /tok/);
  assert.match(c.sql[0], /api\.policy_list/);
  for (const q of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) {
    assert.equal((await listPolicies(mk().d, new Request('http://x/?' + q))).status, 400);
  }
});

// ---- PM 11/21 지시 1: Q10 권한·데이터 접근 정적 검증 ----
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

test('PA10 policyAdmin 데이터 접근: 견적 규칙만 import, SQL은 api.policy_* 함수뿐, 수수료·원문 위치·테이블 직접 접근 없음', () => {
  const root = path.resolve(__dirname, '../../src');
  const src = readFileSync(path.join(root, 'server/admin/policyAdmin.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // 정책 모듈에서는 quotePolicy 하나만 가져온다(내부 값·저장 형식 타입 등 다른 이름 금지)
  const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/server\/policies'/g)].map((m) => m[1].trim());
  assert.deepEqual(imports, ['quotePolicy']);
  // SQL: tx 태그 안의 api.* 호출은 policy_* 뿐이고 테이블 직접 접근·수수료·정산 문구가 없다
  const sqls = [...code.matchAll(/tx`([\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(sqls.length >= 5);
  for (const q of sqls) {
    const fns = [...q.matchAll(/\bapi\.([a-z_]+)/g)].map((m) => m[1]);
    assert.ok(fns.length >= 1 && fns.every((f) => /^(policy_(list|create_draft|submit|approve|reject|publish_get|publish_set)|notice_text_(list|add))$/.test(f)), q.slice(0, 60));
    assert.doesNotMatch(q, /\b(core|pii|security)\.[a-z_]+/);
    assert.doesNotMatch(q, /commission|settlement|source_ref|reveal_contact/i);
  }
  // 서버 권한표: 승인·반려는 owner 한 역할뿐
  assert.match(code, /approve:\s*\['owner'\]/);
  assert.match(code, /reject:\s*\['owner'\]/);
  // 클라이언트 코드는 서버 모듈을 가져오지 않는다(권한 판정을 화면이 하지 않음)
  const client = readFileSync(path.join(root, 'app/admin/policies/PolicyConsole.tsx'), 'utf8');
  assert.match(client, /^'use client'/);
  assert.deepEqual([...client.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]), ['react']);
  // 모든 import 지점 점검: server/policies·policyAdmin을 가져오는 파일은 허용 목록 안에만 있다
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
  walk(root);
  const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
  const adminUsers = files.filter((f) => /server\/admin\/policyAdmin'/.test(readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(adminUsers, ['app/admin/notices/page.tsx', 'app/admin/policies/page.tsx', 'app/api/admin/notices/route.ts', 'app/api/admin/policies/[id]/route.ts', 'app/api/admin/policies/publish/route.ts', 'app/api/admin/policies/route.ts']);
});

// ---- PM 11/21 지시 2: JSON 이중 직렬화 회귀 ----
// postgres.js는 `${값}::jsonb` 자리의 JS 문자열을 다시 JSON 문자열로 직렬화한다(실제 DB에서 jsonb 문자열이 되어 terms 형태 검사 거부).
// 그래서 문자열화한 JSON은 반드시 `::text::jsonb`로 넘긴다.
test('PA11 JSON 문자열 파라미터는 ::text::jsonb로 전달(이중 직렬화 방지), 파라미터는 한 번만 직렬화된 객체 JSON', async () => {
  const seen: { q: string; v: unknown[] }[] = [];
  const d: PolicyAdminDeps = {
    env: () => READY_ENV, mode: () => 'supabase', requireStaff: async () => who('owner'), now: () => NOW,
    runInTransaction: async (fn) => fn((async (s: TemplateStringsArray, ...v: unknown[]) => { seen.push({ q: s.join('?'), v }); return [{ id: ID }]; }) as never),
  };
  assert.equal((await createPolicyDraft(d, upload())).status, 201);
  assert.equal((await policyAction(d, ID, { action: 'approve', reason: '확인 완료', checks: { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true } })).status, 200);
  assert.equal(seen.length, 2);
  for (const c of seen) {
    assert.match(c.q, /::text::jsonb/);
    assert.doesNotMatch(c.q.replace(/::text::jsonb/g, ''), /::jsonb/);
    const js = c.v.filter((x) => typeof x === 'string' && x.startsWith('{')) as string[];
    assert.equal(js.length, 1);
    const parsed: unknown = JSON.parse(js[0]);
    assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), '한 번 파싱하면 객체(문자열이 아님)');
  }
});

test('PA12 src 전체: 문자열화한 JSON을 ::jsonb로 직접 캐스트하는 SQL 없음', () => {
  const root = path.resolve(__dirname, '../../src');
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
  walk(root);
  const bad = files.filter((f) => /JSON\.stringify\([^`]*\)\}::jsonb/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(bad, []);
});

import { noticeAdd, noticeList, policyPublishGet, policyPublishSet } from '../../src/server/admin/policyAdmin';
const jj = async (r: Response) => (await r.json()) as Record<string, unknown>;
const SHA = 'a'.repeat(64);

test('PB1 게시 스위치 닫힘·권한: 환경 미충족 503(DB 0회), 조회는 대표·정책 담당·검토자, 변경은 대표만(DB 호출 전 거부)', async () => {
  for (const env of [{}, { ...READY_ENV, NODE_ENV: 'production' }]) { const { d, c } = mk({ env }); assert.equal((await policyPublishGet(d)).status, 503); assert.equal((await policyPublishSet(d, { enabled: true, reason: '시험' })).status, 503); assert.equal(c.staff + c.tx, 0); }
  for (const role of ['owner', 'policy_editor', 'reviewer']) assert.equal((await policyPublishGet(mk({ staff: who(role), tx: () => [{ enabled: false, updated_at: new Date() }] }).d)).status, 200, role);
  assert.equal((await policyPublishGet(mk({ staff: who('counselor') }).d)).status, 403);
  for (const role of ['policy_editor', 'reviewer', 'counselor']) { const { d, c } = mk({ staff: who(role) }); assert.equal((await policyPublishSet(d, { enabled: true, reason: '시험 사유' })).status, 403, role); assert.equal(c.tx, 0); }
  assert.equal((await policyPublishGet(mk({ staff: new StaffAuthError(401, 'X') }).d)).status, 401);
});
test('PB2 게시 변경 입력: 정확한 키·boolean·사유 2~500자, 불량은 DB 0회, 성공은 set 함수 1회(값 바인딩)', async () => {
  for (const b of [{ enabled: true }, { enabled: 'true', reason: '시험' }, { enabled: true, reason: '시험', x: 1 }, null, [], 'x']) { const { d, c } = mk(); assert.equal((await policyPublishSet(d, b)).status, 422); assert.equal(c.tx, 0); }
  for (const reason of ['', ' ', 'a', 'x'.repeat(501), 5]) { const { d, c } = mk(); const r = await policyPublishSet(d, { enabled: false, reason }); assert.deepEqual([r.status, (await jj(r)).code], [422, 'REASON_REQUIRED']); assert.equal(c.tx, 0); }
  for (const enabled of [true, false]) { const { d, c } = mk({ tx: () => [{}] }); const r = await policyPublishSet(d, { enabled, reason: '검수용 환경 시험' }); assert.deepEqual([r.status, (await jj(r)).enabled], [200, enabled]); assert.equal(c.sql.length, 1); assert.match(c.sql[0], /api\.policy_publish_set/); }
});
test('PB3 게시 조회 응답 검사와 DB 오류 변환(원문 비노출)', async () => {
  const r = await policyPublishGet(mk({ tx: () => [{ enabled: true, updated_at: new Date('2026-11-21T00:00:00Z') }] }).d);
  assert.deepEqual([r.status, (await jj(r)).enabled], [200, true]);
  for (const bad of [[], [{ enabled: 'yes' }], [{ enabled: true }, { enabled: false }]]) assert.equal((await policyPublishGet(mk({ tx: () => bad }).d)).status, 502);
  for (const [code, st] of [['42501', 403], ['XX000', 503]] as const) { const r2 = await policyPublishSet(mk({ tx: () => Object.assign(new Error('host=10.0.0.1 secret'), { code }) }).d, { enabled: true, reason: '시험 사유' }); assert.equal(r2.status, st); assert.ok(!JSON.stringify(await jj(r2)).includes('secret')); }
});
test('NA1 고지 문구: 조회는 대표·검토자, 입력은 대표만, 입력 형식 검사(DB 0회), 성공 201+해시, 중복·형식 오류 코드', async () => {
  for (const role of ['owner', 'reviewer']) assert.equal((await noticeList(mk({ staff: who(role), tx: () => [] }).d)).status, 200, role);
  for (const role of ['policy_editor', 'counselor']) assert.equal((await noticeList(mk({ staff: who(role) }).d)).status, 403, role);
  const ok = { version: 'v1', key: 'sample_key', body: '시험 문구', reason: '시험 입력' };
  for (const role of ['reviewer', 'policy_editor', 'counselor']) { const { d, c } = mk({ staff: who(role) }); assert.equal((await noticeAdd(d, ok)).status, 403); assert.equal(c.tx, 0); }
  for (const b of [{ ...ok, extra: 1 }, { version: 'v1', key: 'k', body: 'b' }, null, []]) { const { d, c } = mk(); assert.equal((await noticeAdd(d, b)).status, 422); assert.equal(c.tx, 0); }
  for (const bad of [{ version: 'bad version' }, { key: 'Bad-Key' }, { body: ' ' }, { body: 'x'.repeat(2001) }, { version: 5 }]) { const { d, c } = mk(); const r = await noticeAdd(d, { ...ok, ...bad }); assert.deepEqual([r.status, (await jj(r)).code], [422, 'INVALID_NOTICE']); assert.equal(c.tx, 0); }
  { const { d, c } = mk(); assert.equal((await noticeAdd(d, { ...ok, reason: '' })).status, 422); assert.equal(c.tx, 0); }
  const r = await noticeAdd(mk({ tx: () => [{ sha: SHA }] }).d, ok);
  assert.deepEqual([r.status, (await jj(r)).sha256], [201, SHA]);
  assert.equal((await noticeAdd(mk({ tx: () => [{ sha: 'zz' }] }).d, ok)).status, 502);
  const dup = await noticeAdd(mk({ tx: () => Object.assign(new Error('NOTICE_EXISTS'), { code: '22023' }) }).d, ok);
  assert.deepEqual([dup.status, (await jj(dup)).code], [422, 'NOTICE_EXISTS']);
});
