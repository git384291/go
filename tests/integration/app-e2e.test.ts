// PM 11/21: 접수 화면 요청 → 서버 접수 코드 → 실제 PostgreSQL → 관리자 조회·정책 승인까지 앱 코드 그대로 실행하는 E2E.
// scripts/db-test.sh가 가상 DB(fideon_test, 시드·가상 고지 문구 포함)를 만든 뒤 실행한다. 운영 DB·실제 고객정보를 쓰지 않는다.
// 접수 요청 본문은 화면(ConsultForm)이 보내는 모양과 같다. 실제 고지 설정은 미확정이라 접수가 막히는 것도 함께 확인한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { withRoleOn } from '../../src/server/db/client';
import { submitLead } from '../../src/server/leads/submitLead';
import type { IntakeContext } from '../../src/server/leads/intake';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import { signToken } from '../../src/server/security/token';
import { adminLeadsList } from '../../src/server/admin/leadsRoute';
import { createPolicyDraft, listPolicies, policyAction, type PolicyAdminDeps } from '../../src/server/admin/policyAdmin';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const SOCK = process.env.FIDEON_TEST_PGSOCK ?? '/tmp';
const PORT = Number(process.env.FIDEON_TEST_PGPORT ?? 54329);
const DB = process.env.FIDEON_TEST_PGDATABASE ?? 'fideon_test';
const conn = (user: string) => postgres({ path: `${SOCK}/.s.PGSQL.${PORT}`, user, database: DB, prepare: false, max: 2, connect_timeout: 3, onnotice: () => {} });
const app = conn('app_server');
const admin = conn('postgres');
after(async () => { await app.end(); await admin.end(); });

const staffKey = { keyId: 1, secret: Buffer.alloc(32, 0x11) };
const leadKey = { keyId: 1, secret: Buffer.alloc(32, 0x22) };
const OWNER = '00000000-0000-4000-8000-000000000001';
const OWNER_S = '10000000-0000-4000-8000-000000000001';
const EDITOR = '00000000-0000-4000-8000-000000000006';
const EDITOR_S = '10000000-0000-4000-8000-000000000008';
const who = (actor: string, session: string, role: string) => ({ actor, session, token: signToken('staff', [actor, session], staffKey), role }) as StaffIdentity;
const owner = who(OWNER, OWNER_S, 'owner');
const editor = who(EDITOR, EDITOR_S, 'policy_editor');

// 화면이 만드는 고지 설정과 같은 모양(시험 DB의 가상 문구 키 3개). 실제 문구 아님
const TEST_NOTICES = {
  version: 'privacy-test-v1', confirmed: true,
  items: ['collection_purpose', 'not_a_contract', 'policy_confirm'].map((key) => ({ key, title: '시험 고지', body: '시험용 문구' })),
};
const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
  crypto: createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: Buffer.alloc(32, 4) }),
  signingKey: leadKey, currentPrivacyVersion: 'privacy-test-v1', clientIp: '203.0.113.201', notices: TEST_NOTICES, ...over,
});
const run = (fn: (tx: never) => PromiseLike<unknown>) => withRoleOn(app, 'public', (tx) => Promise.resolve(fn(tx as never)));
const body = (over: Record<string, unknown> = {}) => ({
  name: '김이투이', phone: '010-7777-1234', interest: 'internet_tv', contactTime: '평일 저녁',
  consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1',
  noticeVersion: 'privacy-test-v1', noticeKeys: TEST_NOTICES.items.map((n) => n.key),
  idempotencyKey: 'e2e-intake-0000000000001', utmSource: 'naver', utmMedium: 'cpc', utmCampaign: 'e2e', ...over,
});
const count = async (sql: string) => Number(((await admin.unsafe(sql)) as unknown as { n: number | string }[])[0].n);
const LEADS = `select count(*)::int as n from core.leads`;
const AUDITS = `select count(*)::int as n from core.audit_logs`;

test('E1 필수 고지 미확정(실제 설정)이면 접수 거부·DB 0건 증가', async () => {
  const before = await count(LEADS);
  const { notices: _omit, ...real } = ctx();
  const r = await submitLead(body(), real, run);
  assert.deepEqual(r, { ok: false, code: 'NOTICE_NOT_CONFIRMED', status: 503 });
  assert.equal(await count(LEADS), before);
});

test('E2 접수 → DB 저장: 암호화 저장·동의·고지 노출 기록·감사', async () => {
  const [l0, a0] = [await count(LEADS), await count(AUDITS)];
  const r = await submitLead(body(), ctx(), run);
  assert.deepEqual(r, { ok: true });
  assert.equal(await count(LEADS), l0 + 1);
  assert.ok((await count(AUDITS)) > a0, '감사 기록 증가');
  const [row] = await admin`
    select c.name_enc, c.phone_enc, c.id::text as cid, l.name_masked, l.phone_last4, l.interest
    from core.leads l join pii.customers c on c.id = l.customer_id
    where l.idempotency_key = 'e2e-intake-0000000000001'`;
  assert.ok(row, '저장된 리드');
  // 원문은 DB 어디에도 평문으로 없다
  assert.ok(!String(row.name_enc).includes('김이투이'));
  assert.ok(!String(row.phone_enc).includes('7777') && !String(row.phone_enc).includes('1234'));
  assert.equal(row.phone_last4, '1234');
  assert.ok(!String(row.name_masked).includes('김이투이'));
  const [exp] = await admin`select count(*)::int as n, count(distinct notice_key)::int as k from pii.notice_exposures where customer_id = ${row.cid}::uuid and doc_version = 'privacy-test-v1'`;
  assert.deepEqual({ n: exp.n, k: exp.k }, { n: 3, k: 3 });
  const [con] = await admin`select count(*)::int as n from pii.consents where customer_id = ${row.cid}::uuid and granted = true and doc_version = 'privacy-test-v1'`;
  assert.ok(con.n >= 1, '수집·이용 동의 기록');
});

test('E3 같은 요청 키 재전송: 리드 중복 생성 없음', async () => {
  const l0 = await count(LEADS);
  const r = await submitLead(body(), ctx({ clientIp: '203.0.113.202' }), run);
  assert.equal(r.ok, true);
  assert.equal(await count(LEADS), l0);
});

test('E4 접수 거부: 고지 항목 누락·버전 불일치는 DB에 쓰지 않음', async () => {
  const l0 = await count(LEADS);
  const a = await submitLead(body({ idempotencyKey: 'e2e-intake-0000000000002', noticeKeys: ['collection_purpose'] }), ctx(), run);
  const b = await submitLead(body({ idempotencyKey: 'e2e-intake-0000000000003', noticeVersion: 'old' }), ctx(), run);
  assert.deepEqual([a.ok ? 'ok' : a.code, b.ok ? 'ok' : b.code], ['NOTICE_ACK_REQUIRED', 'NOTICE_VERSION_MISMATCH']);
  assert.equal(await count(LEADS), l0);
});

// 시험 DB에는 앞선 시험이 만든 예약 상품 등 다른 행이 있어, 가장 최근 1건(= 위 E2 접수 건)만 조회한다
test('E5 관리자 조회: 접수 건이 마스킹되어 목록에 보이고 원문은 없다', async () => {
  const res = await adminLeadsList({
    env: () => ({ ADMIN_LEADS_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_1_abcdef01' }),
    mode: () => 'supabase',
    requireStaff: async () => owner,
    runInTransaction: (fn) => withRoleOn(app, 'staff', (tx) => fn(tx as never)),
    mockList: async () => new Response('{}', { status: 500 }),
    mockDetail: async () => new Response('{}', { status: 500 }),
  }, new Request('http://x/api/admin/leads?limit=1'));
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 200));
  assert.match(text, /010-\*\*\*\*-1234/);
  assert.ok(!text.includes('7777') && !text.includes('김이투이') && !text.includes('v1:'));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

test('E6 암호화·RLS·권한 회귀: 앱 계정은 PII 테이블을 직접 읽을 수 없고 RLS가 강제됨', async () => {
  for (const t of ['pii.customers', 'pii.notice_exposures', 'pii.consents', 'core.leads', 'core.policy_versions', 'core.notice_texts']) {
    const [r] = await admin`select relrowsecurity as rls_on, relforcerowsecurity as forced from pg_class where oid = ${t}::regclass`;
    assert.deepEqual({ t, on: r.rls_on, forced: r.forced }, { t, on: true, forced: true });
  }
  await assert.rejects(app`select name_enc from pii.customers limit 1`, (e: { code?: string }) => e.code === '42501');
  await assert.rejects(withRoleOn(app, 'public', (tx) => tx`select * from core.leads limit 1`), (e: { code?: string }) => e.code === '42501');
  await assert.rejects(withRoleOn(app, 'staff', (tx) => tx`select phone_enc from pii.customers limit 1`), (e: { code?: string }) => e.code === '42501');
  // 고지 문구는 저장 뒤 고칠 수 없다
  await assert.rejects(admin`update core.notice_texts set body = '변경' where version = 'privacy-test-v1'`);
});

const readyEnv = { ADMIN_POLICY_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_1_abcdef01' };
const pdeps = (who: StaffIdentity): PolicyAdminDeps => ({
  env: () => readyEnv, mode: () => 'supabase', requireStaff: async () => who,
  runInTransaction: (fn) => withRoleOn(app, 'staff', (tx) => fn(tx as never)), now: () => new Date(),
});
const known = (value: unknown) => ({ known: true, value });
const krw = (n: number) => known({ amountKrw: n, vat: 'included' });
const uploadBody = () => {
  const t = Date.now();
  return {
    supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'e2e-p1', category: 'internet_tv', sourceKind: 'official_policy_sheet',
    confirmedAt: new Date(t - 3600_000).toISOString(), validFrom: new Date(t - 3600_000).toISOString(), validUntil: new Date(t + 86_400_000).toISOString(),
    productLabel: '가상 인터넷+TV(E2E)',
    terms: {
      monthlyFee: krw(11111), contractMonths: known(36), equipmentMonthlyFee: krw(0), installFee: krw(2222), bundlePrerequisites: known([]), regionScope: known('nationwide'),
      customerBenefit: known({ amountKrw: 3333, form: 'gift_card', payoutCondition: known('x'), cancellationCondition: known('y') }),
    },
  };
};
const stateOf = async (id: string) => ((await admin`select state from core.policy_versions where id = ${id}::uuid`)[0] as { state: string }).state;
const ALL = { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true };

test('E7 관리자 정책: 초안 → 제출 → 승인, 승인 권한 우회 불가(서버·DB 모두), 감사 기록', async () => {
  const dry = await createPolicyDraft(pdeps(editor), { ...uploadBody(), dryRun: true });
  assert.equal(((await dry.json()) as { quotable: boolean }).quotable, true);
  const created = await createPolicyDraft(pdeps(editor), uploadBody());
  const cj = (await created.json()) as { ok: boolean; id: string; code?: string };
  assert.equal(created.status, 201, JSON.stringify(cj));
  const id = cj.id;
  assert.equal(await stateOf(id), 'draft');

  // 서버 선검사: policy_editor는 승인 요청이 DB까지 가지 않는다
  const a0 = await count(AUDITS);
  const viaServer = await policyAction(pdeps(editor), id, { action: 'approve', reason: '확인 완료', checks: ALL });
  assert.equal(viaServer.status, 403);
  // 서버를 거치지 않고 DB 함수를 직접 불러도 DB가 막는다
  await assert.rejects(
    withRoleOn(app, 'staff', (tx) => tx`select api.policy_approve(${EDITOR}::uuid, ${EDITOR_S}::uuid, ${editor.token}, ${id}::uuid, ${'확인 완료'}, ${JSON.stringify(ALL)}::text::jsonb)`),
    (e: { code?: string }) => e.code === '42501',
  );
  assert.equal(await stateOf(id), 'draft');
  // 초안 상태에서는 대표도 승인할 수 없다(검수 요청 먼저)
  const early = await policyAction(pdeps(owner), id, { action: 'approve', reason: '확인 완료', checks: ALL });
  assert.ok(early.status >= 400, '초안 승인 거부');
  assert.equal(await stateOf(id), 'draft');

  assert.equal((await policyAction(pdeps(editor), id, { action: 'submit' })).status, 200);
  assert.equal(await stateOf(id), 'submitted');
  // 확인 항목 하나라도 빠지면 거부, 전부 true + 사유면 승인
  assert.equal((await policyAction(pdeps(owner), id, { action: 'approve', reason: '확인 완료', checks: { ...ALL, vat: false } })).status, 422);
  assert.equal(await stateOf(id), 'submitted');
  const ok = await policyAction(pdeps(owner), id, { action: 'approve', reason: '정책표 원문과 대조 완료', checks: ALL });
  assert.equal(ok.status, 200, await ok.text());
  assert.equal(await stateOf(id), 'approved');
  assert.ok((await count(AUDITS)) > a0, '승인 감사 기록');

  const list = await listPolicies(pdeps(owner), new Request('http://x/api/admin/policies?limit=100'));
  const lj = (await list.json()) as { items: { id: string; state: string }[] };
  assert.equal(lj.items.find((i) => i.id === id)?.state, 'approved');
  assert.ok(!JSON.stringify(lj).includes('commission'));
  // 게시 스위치(policy_publish)는 이 화면이 켜지 않는다: 꺼져 있으면 고객 상담 경로로 나가지 않는다
  const [flag] = await admin`select enabled from core.feature_flags where key = 'policy_publish'`;
  assert.equal(flag?.enabled ?? false, false);
  let published = '';
  try { published = JSON.stringify(await withRoleOn(app, 'public', (tx) => tx`select api.policy_published() as p`)); } catch { published = ''; }
  assert.ok(!published.includes('e2e-p1'), '스위치 꺼짐: 승인된 정책도 고객 경로에 나가지 않음');
});
