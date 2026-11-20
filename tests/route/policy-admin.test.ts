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
