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
import { answerQuote } from '../../src/server/consult/quoteAnswer';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { handleChat } from '../../src/server/consult/chatHandler';
import { createAiBudget, createDbAiBudget, mockModel, ModelNotCalledError, type ChatModel } from '../../src/server/consult/chatModel';
import { dbPolicyProvider } from '../../src/server/consult/publishedPolicies';
import { adFunnel, adRunAction } from '../../src/server/admin/adRun';
import { mockPlatform, type AdPlatform } from '../../src/server/advertising/platform';
import { adBudgetAction, adBudgetOverview, type AdBudgetDeps } from '../../src/server/admin/adBudget';
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
    select c.name_enc, c.phone_enc, c.id::text as cid, l.name_masked, l.phone_last4, l.interest, l.utm_source, l.utm_medium, l.utm_campaign
    from core.leads l join pii.customers c on c.id = l.customer_id
    where l.idempotency_key = 'e2e-intake-0000000000001'`;
  assert.ok(row, '저장된 리드');
  // 원문은 DB 어디에도 평문으로 없다
  assert.ok(!String(row.name_enc).includes('김이투이'));
  assert.ok(!String(row.phone_enc).includes('7777') && !String(row.phone_enc).includes('1234'));
  assert.equal(row.phone_last4, '1234');
  // 유입 추적: 광고 UTM이 리드에 그대로 저장된다
  assert.deepEqual({ s: row.utm_source, m: row.utm_medium, c: row.utm_campaign }, { s: 'naver', m: 'cpc', c: 'e2e' });
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
  // 회귀(이중 직렬화): terms는 jsonb 객체여야 하고 문자열 스칼라가 아니다
  const [shape] = await admin`select jsonb_typeof(terms) as t, terms -> 'monthlyFee' -> 'value' ->> 'amountKrw' as fee from core.policy_versions where id = ${id}::uuid`;
  assert.deepEqual({ t: shape.t, fee: shape.fee }, { t: 'object', fee: '11111' });

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
  const [ck] = await admin`select jsonb_typeof(checks) as t, checks ->> 'vat' as vat, decided_by::text as by from core.policy_versions where id = ${id}::uuid`;
  assert.deepEqual({ t: ck.t, vat: ck.vat, by: ck.by }, { t: 'object', vat: 'true', by: OWNER });
  assert.ok((await count(AUDITS)) > a0, '승인 감사 기록');

  const list = await listPolicies(pdeps(owner), new Request('http://x/api/admin/policies?limit=100'));
  const lj = (await list.json()) as { items: { id: string; state: string }[] };
  assert.equal(lj.items.find((i) => i.id === id)?.state, 'approved');
  assert.ok(!JSON.stringify(lj).includes('commission'));
  // 게시 스위치(policy_publish)는 이 화면이 켜지지 않는다. 스위치 값은 앞선 시험이 바꿔 둘 수 있으니 직접 끄고 켜며 확인하고 원래대로 돌려 놓는다
  const [flag] = await admin`select enabled from core.feature_flags where key = 'policy_publish'`;
  const original = flag?.enabled ?? false;
  const published = async () => {
    try { return JSON.stringify(await withRoleOn(app, 'public', (tx) => tx`select api.policy_published() as p`)); } catch { return ''; }
  };
  const mentions = (t: string) => t.includes('e2e-p1') || t.includes('E2E');
  try {
    await admin`update core.feature_flags set enabled = false where key = 'policy_publish'`;
    assert.ok(!mentions(await published()), '스위치 꺼짐: 승인된 정책도 고객 경로에 나가지 않음');
    await admin`update core.feature_flags set enabled = true where key = 'policy_publish'`;
    const on = await published();
    assert.ok(mentions(on) && on.includes('11111'), '스위치 켜짐: 승인된 정책의 고객용 값만 고객 경로에 나감');
    assert.ok(!/commission|source_ref|created_by|checks/i.test(on), '고객 경로에는 내부 값 없음');
  } finally {
    await admin`update core.feature_flags set enabled = ${original} where key = 'policy_publish'`;
  }
});

// 승인 정책 → 상담 금액 안내: 실제 DB의 게시 함수 → 서버 제공자 → 견적 판정 → 안내 문구까지. 승인·게시된 정책만 금액이 나간다
test('E8 상담 안내: 스위치 꺼짐·미승인·모르는 상품은 담당자 확인 안내, 승인·게시된 정책은 승인 금액만 안내', async () => {
  const provider = dbPolicyProvider(async () => {
    const rows = (await withRoleOn(app, 'public', (tx) => tx`select api.policy_published() as p`)) as unknown as { p: unknown }[];
    return rows.map((r) => r.p);
  });
  const req = (productId: string) => ({
    supplierId: 'supplier-a', segment: 'household' as const, carrier: 'carrier-x', productId, regionCode: 'region-1',
    confirmedBundles: { known: true as const, value: [] as string[] },
  });
  const [flag] = await admin`select enabled from core.feature_flags where key = 'policy_publish'`;
  const original = flag?.enabled ?? false;
  try {
    await admin`update core.feature_flags set enabled = false where key = 'policy_publish'`;
    const off = await answerQuote(provider, req('e2e-p1'), new Date());
    assert.equal(off.kind, 'needs_review');
    assert.ok(!off.text.includes('11,111') && !off.text.includes('11111'));
    await admin`update core.feature_flags set enabled = true where key = 'policy_publish'`;
    const on = await answerQuote(provider, req('e2e-p1'), new Date());
    assert.equal(on.kind, 'quote', on.text);
    assert.ok(on.text.includes('11,111') || on.text.includes('11111'), on.text);
    const unknown = await answerQuote(provider, req('no-such-product'), new Date());
    assert.equal(unknown.kind, 'needs_review');
    assert.ok(!unknown.text.includes('11,111'));
  } finally {
    await admin`update core.feature_flags set enabled = ${original} where key = 'policy_publish'`;
  }
});

// 광고 예산 통제: 승인 없으면 차단 → 승인 → 한도·중복·동시 요청 → 권한 우회 불가 → 감사 기록. 실제 광고 집행 없음
const REVIEWER = '00000000-0000-4000-8000-000000000005';
const REVIEWER_S = '10000000-0000-4000-8000-000000000005';
const reviewer = who(REVIEWER, REVIEWER_S, 'reviewer');
const adDeps = (w: StaffIdentity): AdBudgetDeps => ({
  env: () => ({ ADMIN_AD_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_1_abcdef01' }),
  mode: () => 'supabase', requireStaff: async () => w,
  runInTransaction: (fn) => withRoleOn(app, 'staff', (tx) => fn(tx as never)), now: () => new Date(),
});
const spendReq = (campaign: string, amountKrw: number, requestKey: string) => ({ action: 'request', campaign, amountKrw, requestKey });
const decide = async (w: StaffIdentity, b: unknown) => { const r = await adBudgetAction(adDeps(w), b); return (await r.json()) as { decision?: string; reason?: string; ok: boolean }; };
const ledgerSum = async (c: string) => Number(((await admin`select coalesce(sum(amount_krw), 0)::int as n from core.ad_spend_ledger where campaign_key = ${c}`)[0] as { n: number }).n);

test('E9 광고 예산: 승인 없으면 차단, 한도·중복·동시 요청 통제, 권한 우회 불가, 감사 기록', async () => {
  const C = 'e2e-ad';
  assert.deepEqual(await decide(owner, spendReq(C, 1000, 'e2e-ad-req-000000001')), { ok: false, decision: 'BLOCK', reason: 'NO_APPROVAL' });
  assert.equal(await ledgerSum(C), 0);

  // 권한: policy_editor·reviewer는 승인할 수 없다(서버 선검사 + DB 직접 호출도 거부)
  const body = { action: 'approve', campaign: C, dailyCapKrw: 5000, totalCapKrw: 12000, hours: 24, reason: '시험 승인' };
  assert.equal((await adBudgetAction(adDeps(editor), body)).status, 403);
  assert.equal((await adBudgetAction(adDeps(reviewer), body)).status, 403);
  await assert.rejects(
    withRoleOn(app, 'staff', (tx) => tx`select api.ad_budget_approve(${EDITOR}::uuid, ${EDITOR_S}::uuid, ${editor.token}, ${C}, 5000::int, 12000::int, now() + interval '1 day', ${'우회 시도'})`),
    (e: { code?: string }) => e.code === '42501',
  );
  await assert.rejects(
    withRoleOn(app, 'staff', (tx) => tx`select api.ad_spend_request(${EDITOR}::uuid, ${EDITOR_S}::uuid, ${editor.token}, ${C}, 1000::int, ${'e2e-ad-req-000000009'})`),
    (e: { code?: string }) => e.code === '42501',
  );
  assert.equal(Number(((await admin`select count(*)::int as n from core.ad_budget_approvals where campaign_key = ${C}`)[0] as { n: number }).n), 0);
  // 상한 초과 승인은 서버가 DB 전에 거부
  assert.equal((await adBudgetAction(adDeps(owner), { ...body, dailyCapKrw: 10001 })).status, 422);

  const a0 = await count(AUDITS);
  assert.equal((await adBudgetAction(adDeps(owner), body)).status, 201);
  assert.equal((await decide(owner, spendReq(C, 3000, 'e2e-ad-req-000000002'))).decision, 'ALLOW');
  assert.deepEqual(await decide(owner, spendReq(C, 3000, 'e2e-ad-req-000000002')), { ok: false, decision: 'BLOCK', reason: 'DUPLICATE_REQUEST' });
  assert.equal(await ledgerSum(C), 3000, '중복 요청은 두 번 세지 않음');
  assert.equal((await decide(owner, spendReq(C, 2500, 'e2e-ad-req-000000003'))).reason, 'DAILY_CAP_EXCEEDED');
  assert.equal((await decide(owner, spendReq(C, 2000, 'e2e-ad-req-000000004'))).decision, 'ALLOW');
  assert.equal(await ledgerSum(C), 5000);
  assert.equal((await decide(owner, spendReq(C, 1, 'e2e-ad-req-000000005'))).reason, 'DAILY_CAP_EXCEEDED');
  assert.ok((await count(AUDITS)) >= a0 + 5, '승인·허용·차단이 모두 감사 기록에 남음');

  // 동시 요청: 일 한도 10,000원에 4,000원 5건을 한꺼번에 → 정확히 2건만 허용
  const C2 = 'e2e-ad-par';
  assert.equal((await adBudgetAction(adDeps(owner), { ...body, campaign: C2, dailyCapKrw: 10000, totalCapKrw: 30000 })).status, 201);
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => decide(owner, spendReq(C2, 4000, `e2e-ad-par-req-00000${i}`))));
  assert.equal(results.filter((r) => r.decision === 'ALLOW').length, 2);
  assert.equal(await ledgerSum(C2), 8000);

  // 철회 → 즉시 차단
  assert.equal((await adBudgetAction(adDeps(owner), { action: 'revoke', campaign: C2, reason: '철회 시험' })).status, 200);
  assert.equal((await decide(owner, spendReq(C2, 100, 'e2e-ad-par-req-000009'))).reason, 'NO_APPROVAL');

  // 조회: 검토자 가능(지출 합계 포함), 상담원 불가
  const ov = await adBudgetOverview(adDeps(reviewer), new Request('http://x/api/admin/ads/budget?limit=50'));
  const oj = (await ov.json()) as { items: { campaign_key: string; state: string; spent_total: number }[] };
  assert.equal(ov.status, 200);
  assert.equal(oj.items.find((i) => i.campaign_key === C && i.state === 'active')?.spent_total, 5000);
  assert.equal((await adBudgetOverview(adDeps(who('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'counselor')), new Request('http://x/'))).status, 403);
  // 앱 계정은 원장·승인 테이블을 직접 읽거나 고칠 수 없다
  await assert.rejects(withRoleOn(app, 'staff', (tx) => tx`select * from core.ad_spend_ledger`), (e: { code?: string }) => e.code === '42501');
  await assert.rejects(admin`update core.ad_spend_ledger set amount_krw = 1 where campaign_key = ${C}`);
});

// AI 상담 → 가입 접수 → DB → 관리자 조회(실제 DB, 무료 모의 모델, 실제 AI 호출 없음)
test('E10 AI 상담: 승인 정책만 안내 → 접수 → DB 암호화 저장 → 관리자 마스킹 조회, 개인정보는 모델에 가려서만 전달', async () => {
  const provider = dbPolicyProvider(async () => {
    const rows = (await withRoleOn(app, 'public', (tx) => tx`select api.policy_published() as p`)) as unknown as { p: unknown }[];
    return rows.map((r) => r.p);
  });
  const seen: string[] = [];
  const spy: ChatModel = { ...mockModel, name: 'spy', generate: (i, sig) => { seen.push(JSON.stringify(i)); return mockModel.generate(i, sig); } };
  const chat = { provider, supplierId: 'supplier-a', model: spy, budget: createAiBudget({}) };
  const input = (message: string) => ({ message, carrier: 'carrier-x', productId: 'e2e-p1', regionCode: 'region-1' });
  const [flag] = await admin`select enabled from core.feature_flags where key = 'policy_publish'`;
  const original = flag?.enabled ?? false;
  try {
    await admin`update core.feature_flags set enabled = false where key = 'policy_publish'`;
    const off = await answerChat(chat, input('요금과 사은품이 궁금해요'), new Date());
    assert.ok(off.ok && off.kind === 'needs_review' && !/11,?111/.test(off.text));
    await admin`update core.feature_flags set enabled = true where key = 'policy_publish'`;
    const on = await answerChat(chat, input('이름은 김철수 010-9999-8888 요금이 궁금해요'), new Date());
    assert.ok(on.ok && on.kind === 'quote' && on.source === 'model' && /11,?111/.test(on.text), JSON.stringify(on));
    assert.ok(!seen.join().includes('9999') && !seen.join().includes('김철수'));
  } finally {
    await admin`update core.feature_flags set enabled = ${original} where key = 'policy_publish'`;
  }
  // 상담 → 접수(기존 접수 모듈) → DB → 관리자 조회
  const l0 = await count(LEADS);
  const r = await submitLead(body({ idempotencyKey: 'e2e-chat-signup-0000001', phone: '010-5555-4321', name: '김삼삼' }), ctx(), run);
  assert.deepEqual(r, { ok: true });
  assert.equal(await count(LEADS), l0 + 1);
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
  assert.match(text, /010-\*\*\*\*-4321/);
  assert.ok(!text.includes('5555') && !text.includes('김삼삼'));
});

// 광고 생성·승인 → 모의 집행 → 성과 수집 → 유입→접수 분석, AI 사용료 DB 집계 (실제 DB, 실제 광고·AI 호출 없음)
const kst = (offset = 0) => new Date(Date.now() + 9 * 3_600_000 - offset * 86_400_000).toISOString().slice(0, 10);
test('E11 광고: 승인 없이는 집행 차단 → 승인 → 모의 집행·원장 → 성과 수집(초과 표시) → 접수 연결 분석, 권한·실집행 스위치 차단', async () => {
  const runDeps = (w: StaffIdentity, platform: AdPlatform | null = mockPlatform, env: Record<string, string> = {}) => ({ ...adDeps(w), platform, env: () => ({ ...adDeps(w).env(), ...env }) });
  const camp = 'e11-camp';
  const launch = (w: StaffIdentity, key: string, amount = 400, platform: AdPlatform | null = mockPlatform, env: Record<string, string> = {}) =>
    adRunAction(runDeps(w, platform, env), { action: 'launch', campaign: camp, amountKrw: amount, requestKey: key });
  const body0 = async (r: Response) => (await r.json()) as Record<string, unknown>;
  // 1) 승인 없음 → 차단, 원장 0
  const blocked = await body0(await launch(owner, 'e11-key-0000000000001'));
  assert.deepEqual([blocked.decision, blocked.reason], ['BLOCK', 'NO_APPROVAL']);
  // 2) 권한 우회: editor·reviewer는 집행·수집 불가(서버 403), 실제(live) 어댑터는 스위치 없이 DB도 건드리지 않고 차단
  for (const w of [editor, reviewer]) assert.equal((await launch(w, 'e11-key-0000000000002')).status, 403);
  const live: AdPlatform = { ...mockPlatform, name: 'live-fake', live: true };
  const before = await count(`select count(*)::int as n from core.audit_logs where action like 'ad.spend%'`);
  const over0 = await count(`select count(*)::int as n from core.audit_logs where action = 'ad.performance_overspend'`); // DB 시험(80)이 남긴 기록 제외
  const sw = await launch(owner, 'e11-key-0000000000003', 400, live);
  assert.deepEqual([sw.status, (await body0(sw)).reason], [403, 'EXECUTION_DISABLED']);
  assert.equal(await count(`select count(*)::int as n from core.audit_logs where action like 'ad.spend%'`), before);
  // 3) 승인 → 모의 집행(허용, executed=false) → 같은 키 재전송은 차단, 한도 초과 차단
  const ap = await adBudgetAction(adDeps(owner), { action: 'approve', campaign: camp, dailyCapKrw: 1000, totalCapKrw: 3000, hours: 24, reason: 'E11 승인' });
  assert.equal(ap.status, 201);
  const ok = await body0(await launch(owner, 'e11-key-0000000000004', 500));
  assert.deepEqual([ok.ok, ok.executed, ok.simulated], [true, false, true]);
  assert.equal((await body0(await launch(owner, 'e11-key-0000000000004', 500))).reason, 'DUPLICATE_REQUEST');
  assert.equal((await body0(await launch(owner, 'e11-key-0000000000005', 600))).reason, 'DAILY_CAP_EXCEEDED');
  assert.equal(await ledgerSum(camp), 500);
  // 4) 성과 수집: 원장 안(400 ≤ 500)은 정상, 원장 없는 어제 100원은 초과 표시, 같은 날 재수집은 중복 없음
  let paused = 0;
  const fake = (cost: number): AdPlatform => ({ ...mockPlatform, async pause() { paused++; return { paused: true }; }, async fetchPerformance() { return { impressions: 1000, clicks: 40, costKrw: cost }; } });
  const col = async (day: string, cost: number, w = owner) => adRunAction(runDeps(w, fake(cost)), { action: 'collect', campaign: camp, day });
  assert.deepEqual(await body0(await col(kst(0), 400)), { ok: true, recorded: true, overLedger: false, source: 'mock' });
  assert.equal((await body0(await col(kst(0), 400))).recorded, false);
  assert.equal(paused, 0); // 정상 수집은 중지하지 않는다
  const over = await body0(await col(kst(1), 100));
  assert.equal(over.overLedger, true);
  // 초과 감지 → 자동 중지: 승인 철회 + 플랫폼 중지, 이후 모든 지출 차단
  assert.deepEqual(over.autoStop, { revoked: true, revokeNote: null, paused: true, simulated: true });
  assert.equal(paused, 1);
  assert.equal((await body0(await launch(owner, 'e11-key-0000000000006', 100))).reason, 'NO_APPROVAL');
  assert.equal(await ledgerSum(camp), 500);
  assert.equal(await count(`select count(*)::int as n from core.audit_logs where action = 'ad.budget_revoke' and reason = '광고비 초과 감지 자동 중지'`) >= 1, true);
  assert.equal((await col(kst(0), 400, reviewer)).status, 403);
  assert.equal((await col(kst(-1), 100)).status, 422); // 미래 날짜
  assert.equal(await count(`select count(*)::int as n from core.audit_logs where action = 'ad.performance_overspend'`), over0 + 1);
  await assert.rejects(admin`update core.ad_performance set cost_krw = 0`, (e: { code?: string }) => e.code === '42501');
  // 5) 유입 → 접수: utm_campaign이 같은 접수가 분석에 접수로 잡히고 개인정보는 응답에 없다
  assert.deepEqual(await submitLead(body({ idempotencyKey: 'e2e-ad-signup-000000001', phone: '010-4444-9876', name: '김사사', utmCampaign: camp }), ctx(), run), { ok: true });
  const fr = await adFunnel(adDeps(reviewer), new Request(`http://x/api/admin/ads/funnel?from=${kst(7)}&to=${kst(0)}`));
  const ft = await fr.text();
  assert.equal(fr.status, 200, ft.slice(0, 200));
  const row = (JSON.parse(ft).items as Record<string, unknown>[]).find((i) => i.campaign === camp);
  assert.ok(row, ft.slice(0, 300));
  assert.deepEqual([row.impressions, row.clicks, row.costKrw, row.ledgerKrw, row.leads, row.overBudget, row.costPerLeadKrw], [2000, 80, 500, 500, 1, true, 500]);
  assert.ok(!ft.includes('4444') && !ft.includes('김사사') && !ft.includes('9876'));
  assert.equal((await adFunnel(adDeps(who('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'counselor')), new Request('http://x/'))).status, 403);
});

test('E12 AI 사용료 DB 집계: 기본 0원이면 호출 금지, 예약→확정/취소, 호출 전 실패만 취소·장애는 확정, 한도 안에서만(동시 포함), 전용 역할만 실행', async () => {
  const budget = createDbAiBudget((fn) => withRoleOn(app, 'ai', (tx) => fn(tx as never)));
  const used = async () => count(`select coalesce(sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end), 0)::int as n
    from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id`);
  const u0 = await used();
  const [cfg] = await admin`select monthly_limit_krw from core.ai_budget_config where singleton`;
  assert.equal(cfg.monthly_limit_krw, 0);
  assert.equal(await budget.reserve(3), null);
  assert.equal(await used(), u0);
  // 유료로 가정한 모델은 한도 0원이면 호출 0회(상담 경로 전체)
  let calls = 0;
  const paid: ChatModel = { name: 'paid-fake', costPerCallKrw: 3, async generate() { calls++; return '안내'; } };
  const provider = dbPolicyProvider(async () => []);
  const ask = (model: ChatModel) => answerChat({ provider, supplierId: 'supplier-a', model, budget }, { message: '요금?', carrier: 'carrier-x', productId: 'e2e-p1', regionCode: 'region-1' }, new Date());
  const chat = await ask(paid);
  assert.ok(chat.ok && chat.source === 'fallback' && calls === 0);
  try {
    await admin`update core.ai_budget_config set monthly_limit_krw = ${u0 + 10} where singleton`;
    // 정상 호출: 예약 3 → 호출 → 확정(모델 비용 3)
    const ok = await ask(paid);
    assert.ok(ok.ok && ok.source === 'model' && calls === 1);
    assert.equal(await used(), u0 + 3);
    // 호출 전 실패(설정 누락 등)는 취소 → 사용액 변화 없음
    const unsent: ChatModel = { name: 'no-key', costPerCallKrw: 3, async generate() { throw new ModelNotCalledError('no key'); } };
    const c1 = await ask(unsent);
    assert.ok(c1.ok && c1.source === 'fallback');
    assert.equal(await used(), u0 + 3);
    // 장애(비용이 났을 수 있음)는 확정 → 사용액 증가
    const down: ChatModel = { name: 'down', costPerCallKrw: 3, async generate() { throw new Error('upstream 500'); } };
    const c2 = await ask(down);
    assert.ok(c2.ok && c2.source === 'fallback');
    assert.equal(await used(), u0 + 6);
    // 직접 확정·취소: 같은 예약 재정산 불가, 실제 비용이 예약보다 작으면 줄어듦
    const r = await budget.reserve(4);
    assert.ok(r);
    await r.confirm(1);
    await r.cancel(); // 이미 확정됨 → 무시
    assert.equal(await used(), u0 + 7);
    // 동시 예약: 남은 3원 → 3원짜리는 정확히 1건만
    const got = await Promise.all(Array.from({ length: 5 }, () => budget.reserve(3)));
    assert.equal(got.filter(Boolean).length, 1);
    assert.equal(await used(), u0 + 10);
    // 미정산 예약은 전액으로 센다(보수적) — 위 동시 예약 1건이 미정산
    assert.equal(await budget.reserve(1), null);
  } finally {
    await admin`update core.ai_budget_config set monthly_limit_krw = 0 where singleton`;
  }
  // 다른 역할·직접 접근 차단
  for (const role of ['public', 'staff'] as const) {
    await assert.rejects(withRoleOn(app, role, (tx) => tx`select api.ai_budget_hold(1)`), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(withRoleOn(app, role, (tx) => tx`select api.ai_budget_confirm(1, 1)`), (e: { code?: string }) => e.code === '42501');
  }
  await assert.rejects(withRoleOn(app, 'ai', (tx) => tx`select * from core.ai_usage_ledger`), (e: { code?: string }) => e.code === '42501');
  await assert.rejects(withRoleOn(app, 'ai', (tx) => tx`select * from core.ai_usage_closures`), (e: { code?: string }) => e.code === '42501');
  await assert.rejects(admin`update core.ai_usage_closures set actual_cost_krw = 0`, (e: { code?: string }) => e.code === '42501');
  await assert.rejects(admin`update core.ai_usage_ledger set cost_krw = 1`, (e: { code?: string }) => e.code === '42501');
});

// 상담(AI 상담창) → 필수 고지 → 동의 → 접수 → DB 암호화 저장 → 관리자 마스킹 조회. 상담 시작은 캠페인별로 집계된다
test('E13 상담 시작 집계(API 핸들러→DB): 세션당 1건, 캠페인 연결, 접수까지 이어진 전환이 분석에 보임, 고지 미확정은 접수 차단 유지', async () => {
  const camp = 'e13-camp';
  const mkChat = (session: string, campaign?: string) => handleChat(new Request('http://x/api/consult/chat', { method: 'POST', body: JSON.stringify({ carrier: 'carrier-x', productId: 'e2e-p1', regionCode: 'region-1', message: '요금이 궁금해요', session, ...(campaign ? { campaign } : {}) }) }), {
    enabled: true, limiter: () => true, ip: '203.0.113.50', now: () => new Date(),
    chat: { provider: dbPolicyProvider(async () => []), supplierId: 'supplier-a', model: mockModel, budget: createAiBudget({}) },
    recordConsult: async (sess, c) => { await withRoleOn(app, 'public', (tx) => tx`select api.consult_event_record(${sess}, ${c})`); },
  });
  const c0 = await count(`select count(*)::int as n from core.consult_events where campaign_key = '${camp}'`);
  assert.equal((await mkChat('e13-session-000000001', camp)).status, 200);
  assert.equal((await mkChat('e13-session-000000001', camp)).status, 200); // 같은 창에서 계속 대화해도 1건
  assert.equal((await mkChat('e13-session-000000002', camp)).status, 200);
  assert.equal((await mkChat('e13-session-000000003')).status, 200);       // 캠페인 없는 상담
  assert.equal(await count(`select count(*)::int as n from core.consult_events where campaign_key = '${camp}'`), c0 + 2);
  // 접수는 고지 확정 전에는 막힌다(실제 설정), 시험 고지를 넣은 경우에만 저장된다
  const { notices: _omit, ...real } = ctx();
  const l0 = await count(LEADS);
  assert.deepEqual(await submitLead(body({ idempotencyKey: 'e13-signup-0000000001', phone: '010-3333-2468', name: '김일삼', utmCampaign: camp }), real, run), { ok: false, code: 'NOTICE_NOT_CONFIRMED', status: 503 });
  assert.equal(await count(LEADS), l0);
  assert.deepEqual(await submitLead(body({ idempotencyKey: 'e13-signup-0000000001', phone: '010-3333-2468', name: '김일삼', utmCampaign: camp }), ctx(), run), { ok: true });
  // 분석: 상담 2 → 접수 1, 개인정보는 응답에 없음
  const fr = await adFunnel(adDeps(owner), new Request(`http://x/api/admin/ads/funnel?from=${kst(1)}&to=${kst(0)}`));
  const ft = await fr.text();
  assert.equal(fr.status, 200, ft.slice(0, 200));
  const row = (JSON.parse(ft).items as Record<string, unknown>[]).find((i) => i.campaign === camp);
  assert.ok(row, ft.slice(0, 300));
  assert.deepEqual([row.consults, row.leads, row.leadRate], [c0 + 2, 1, Math.round((1 / (c0 + 2)) * 10000) / 10000]);
  assert.ok(!ft.includes('3333') && !ft.includes('김일삼') && !ft.includes('2468'));
  // 형식 밖 세션은 핸들러가 막아 DB 0회, 앱 역할은 상담 기록을 직접 읽거나 지울 수 없다
  assert.equal((await mkChat('short')).status, 400);
  await assert.rejects(withRoleOn(app, 'public', (tx) => tx`select * from core.consult_events`), (e: { code?: string }) => e.code === '42501');
  await assert.rejects(admin`delete from core.consult_events`, (e: { code?: string }) => e.code === '42501');
});
