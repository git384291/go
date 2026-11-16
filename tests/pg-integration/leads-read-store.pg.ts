// PM 6909719658: 마스킹 목록 어댑터(leadsReadStore)를 실제 로컬 PostgreSQL에서 검증한다.
// scripts/integration/leads-read-store-pg.sh가 만든 폐기용 DB(0001~0006 + zz_grants + 가상 fixture)에서만 실행한다.
// - 앱 조회: app_server 연결 → withRoleOn(..., 'staff') → 어댑터 → api.list_leads (테이블 직접 읽기 지름길 없음)
// - admin(postgres) 연결: 가상 fixture 조작과 결과 확인 전용
// 실제 고객 DB·원격 프로젝트·실키를 쓰지 않는다. 이 파일은 tests/integration/*.test.ts 자동 패턴에 포함되지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { withRoleOn } from '../../src/server/db/client';
import { listMaskedLeads, type LeadsReadDeps, type SqlTag, type ListResult } from '../../src/server/admin/leadsReadStore';
import { signToken } from '../../src/server/security/token';
import type { StaffIdentity } from '../../src/server/auth/staffSession';
import { adminLeadsList, adminLeadDetail, type AdminLeadsDeps } from '../../src/server/admin/leadsRoute';

const SOCK = process.env.FIDEON_LRS_PGSOCK ?? '';
const PORT = Number(process.env.FIDEON_LRS_PGPORT ?? 0);
const DB = process.env.FIDEON_LRS_PGDATABASE ?? '';
if (!SOCK || !PORT || !/^fideon_lrs_[a-z0-9_]{1,40}$/.test(DB)) throw new Error('폐기용 시험 DB 정보 없음: scripts/integration/leads-read-store-pg.sh로 실행');

const conn = (user: string, database = DB) =>
  postgres({ path: `${SOCK}/.s.PGSQL.${PORT}`, user, database, prepare: false, max: 2, connect_timeout: 3, onnotice: () => {} });
const app = conn('app_server');
const admin = conn('postgres');
after(async () => {
  await app.end();
  await admin.end();
});

const KEY = { keyId: 1, secret: Buffer.alloc(32, 0x11) }; // fixture의 가상 staff 키
const BAD_KEY = { keyId: 1, secret: Buffer.alloc(32, 0x99) };
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const CA = 'a0000000-0000-4000-8000-000000000002';
const CB = 'a0000000-0000-4000-8000-000000000003';
const REVIEWER = 'a0000000-0000-4000-8000-000000000004';
const EDITOR = 'a0000000-0000-4000-8000-000000000005';
const INACTIVE = 'a0000000-0000-4000-8000-000000000006';
const S = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;
const L = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`;
const SECRETS = ['LRS-SECRET', 'LRS-FREE', 'v1:', 'dddddddd', 'lrs-idempotency'];

let ttl = 120;
/** 서버가 검증한 직원 컨텍스트를 흉내 낸다(가상). 실제 Auth 검증이 아니다 */
function who(actor: string, session: string, role: StaffIdentity['role'], key = KEY): StaffIdentity {
  ttl = ttl >= 280 ? 120 : ttl + 1;
  return { actor, session, role, token: signToken('staff', [actor, session], key, Math.floor(Date.now() / 1000), ttl) };
}

function deps(counter?: { runs: number }, sql = app): LeadsReadDeps {
  return {
    enabled: () => true,
    runInTransaction: (fn) => {
      if (counter) counter.runs++;
      return withRoleOn(sql, 'staff', (tx) => fn(tx as unknown as SqlTag));
    },
  };
}

async function counts() {
  const [r] = await admin`select (select count(*)::int from core.leads) as leads, (select count(*)::int from pii.customers) as customers,
                                 (select count(*)::int from core.audit_logs) as audits, (select count(*)::int from core.lead_status_history) as history`;
  return { ...r };
}
const noSecrets = (r: ListResult, label: string) => {
  const s = JSON.stringify(r);
  for (const m of SECRETS) assert.ok(!s.includes(m), `${label}: ${m}`);
};

test('P1 owner: 전체 3건(배정 A·B·미배정)을 마스킹 DTO로, 실제 Date·UUID·null 변환, 숨김·자유 입력 미반환', async () => {
  const r = await listMaskedLeads(deps(), who(OWNER, S(1), 'owner'));
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.items.map((i) => i.id), [L(3), L(2), L(1)], 'created_at desc');
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['assignedTo', 'createdAt', 'id', 'interest', 'nameMasked', 'phoneMasked', 'status']);
  assert.deepEqual(r.items[2], { id: L(1), createdAt: '2026-11-16T00:00:01.000Z', nameMasked: '홍*동', phoneMasked: '010-****-1001', interest: 'internet_tv', status: 'new', assignedTo: CA });
  assert.equal(r.items[0].assignedTo, null);
  assert.equal(r.items[1].nameMasked, '김*');
  noSecrets(r, 'owner');
});

test('P2 counselor: 본인 배정만(다른 직원·미배정 없음)', async () => {
  const a = await listMaskedLeads(deps(), who(CA, S(2), 'counselor'));
  assert.equal(a.ok && a.items.map((i) => i.id).join(), L(1));
  const b = await listMaskedLeads(deps(), who(CB, S(3), 'counselor'));
  assert.equal(b.ok && b.items.map((i) => i.id).join(), L(2));
  if (a.ok) assert.ok(a.items.every((i) => i.assignedTo === CA));
});

test('P3 limit·offset이 실제 바인딩으로 적용', async () => {
  const p = await listMaskedLeads(deps(), who(OWNER, S(1), 'owner'), { limit: 1, offset: 1 });
  assert.equal(p.ok && p.items.map((i) => i.id).join(), L(2));
  const q = await listMaskedLeads(deps(), who(OWNER, S(1), 'owner'), { limit: 2, offset: 0 });
  assert.equal(q.ok && q.items.length, 2);
  const c = { runs: 0 };
  assert.deepEqual(await listMaskedLeads(deps(c), who(OWNER, S(1), 'owner'), { limit: 500 }), { ok: false, code: 'INVALID_PAGE' });
  assert.equal(c.runs, 0);
});

test('P4 reviewer·policy_editor: 서버 사전 거부(실행기 0회). DB 함수의 reviewer 허용 차이는 관찰만 기록', async (t) => {
  for (const [actor, session, role] of [[REVIEWER, S(4), 'reviewer'], [EDITOR, S(5), 'policy_editor']] as const) {
    const c = { runs: 0 };
    assert.deepEqual(await listMaskedLeads(deps(c), who(actor, session, role)), { ok: false, code: 'FORBIDDEN' }, role);
    assert.equal(c.runs, 0, role);
  }
  // 관찰: 현재 DB 함수는 reviewer에게 전체 목록을 준다(0002). 고치지 않고 기록만 한다(정정은 별도 승인 migration)
  const rv = who(REVIEWER, S(4), 'reviewer');
  const rows = await withRoleOn(app, 'staff', (tx) => tx`select lead_id from api.list_leads(${rv.actor}::uuid, ${rv.session}::uuid, ${rv.token}, ${50}::int, ${0}::int)`);
  t.diagnostic(`NOTE | DB 관찰: api.list_leads가 reviewer에게 ${rows.length}건 반환(서버 어댑터는 실행 전 거부, DB 정정은 별도 승인)`);
  assert.equal(rows.length, 3, '현재 DB 동작 관찰값(변경 없음)');
  // policy_editor는 DB 함수도 거부
  const e = who(EDITOR, S(5), 'policy_editor');
  await assert.rejects(withRoleOn(app, 'staff', (tx) => tx`select * from api.list_leads(${e.actor}::uuid, ${e.session}::uuid, ${e.token}, ${50}::int, ${0}::int)`), (x: { code?: string }) => x.code === '42501');
});

test('P5 DB 재검증: 만료·폐기 세션, 비활성 직원, 잘못된 서명, 다른 직원 세션 → FORBIDDEN(빈 목록 아님)', async () => {
  const cases: [string, StaffIdentity][] = [
    ['만료 세션(13시간)', who(OWNER, S(7), 'owner')],
    ['폐기 세션', who(OWNER, S(8), 'owner')],
    ['비활성 직원', who(INACTIVE, S(6), 'owner')],
    ['잘못된 서명 키', who(OWNER, S(1), 'owner', BAD_KEY)],
    ['다른 직원 세션', who(OWNER, S(2), 'owner')],
    ['서버 역할 주장과 DB 역할 불일치(counselor를 owner로)', who(CA, S(2), 'owner')],
  ];
  for (const [label, id] of cases) {
    const c = { runs: 0 };
    const r = await listMaskedLeads(deps(c), id);
    if (label.startsWith('서버 역할')) {
      // DB는 실제 역할(counselor)로 범위를 좁혀 본인 배정만 준다. 어댑터는 owner 범위로 검증하므로 성공하되 본인 건만이다
      assert.equal(r.ok && r.items.map((i) => i.id).join(), L(1), label);
      continue;
    }
    assert.deepEqual(r, { ok: false, code: 'FORBIDDEN' }, label);
    assert.equal(c.runs, 1, label);
  }
  // 서명 변조
  const t = who(OWNER, S(1), 'owner');
  assert.deepEqual(await listMaskedLeads(deps(), { ...t, token: t.token.slice(0, -1) + (t.token.endsWith('0') ? '1' : '0') }), { ok: false, code: 'FORBIDDEN' });
});

test('P6 잘못된 행(비활성 상품·원문 이름 모양)이 섞이면 전체 실패, 시험 행은 폐기 DB에서만 추가·제거', async () => {
  const bad: [string, string, string][] = [
    ['비활성 상품', 'cctv_security', '이*순'],
    ['원문+별표 이름', 'internet_tv', 'FixtureName*'],
  ];
  for (const [label, interest, name] of bad) {
    await admin`insert into core.leads (id, name_masked, phone_last4, interest, idempotency_key)
                values ('d0000000-0000-4000-8000-000000000009', ${name}, '1009', ${interest}, 'lrs-idempotency-bad1')`;
    try {
      const r = await listMaskedLeads(deps(), who(OWNER, S(1), 'owner'));
      assert.deepEqual(r, { ok: false, code: 'INVALID_DATA' }, label);
      assert.ok(!JSON.stringify(r).includes('FixtureName'), label);
    } finally {
      await admin`delete from core.leads where id = 'd0000000-0000-4000-8000-000000000009'`;
    }
  }
  // counselor 범위 밖 행이 DB에서 넘어오는 상황은 정상 DB 함수로는 생기지 않는다(가짜 실행기 시험 L4가 담당)
});

test('P7 조회 전후 리드·고객·감사·상태 이력 변화 없음', async () => {
  const before = await counts();
  for (let i = 0; i < 3; i++) {
    await listMaskedLeads(deps(), who(OWNER, S(1), 'owner'));
    await listMaskedLeads(deps(), who(CA, S(2), 'counselor'));
    await listMaskedLeads(deps(), who(OWNER, S(7), 'owner'));
  }
  assert.deepEqual(await counts(), before);
});

test('P8 트랜잭션 안에서만 app_staff·시간 제한, 종료 뒤 app_server로 복구. 장애는 빈 목록이 아니라 UNAVAILABLE', async () => {
  let inside: unknown;
  const probe: LeadsReadDeps = {
    enabled: () => true,
    runInTransaction: (fn) =>
      withRoleOn(app, 'staff', async (tx) => {
        inside = (await tx`select current_user::text as u, current_setting('statement_timeout') as st`)[0];
        return fn(tx as unknown as SqlTag);
      }),
  };
  const r = await listMaskedLeads(probe, who(OWNER, S(1), 'owner'));
  assert.equal(r.ok, true);
  assert.deepEqual({ ...(inside as object) }, { u: 'app_staff', st: '5s' });
  const [outside] = await app`select current_user::text as u`;
  assert.equal(outside.u, 'app_server');
  // app_server는 테이블을 직접 읽을 수 없다(지름길 없음)
  await assert.rejects(app`select count(*) from core.leads`, (x: { code?: string }) => x.code === '42501');
  // 존재하지 않는 DB로 연결 실패 → UNAVAILABLE, 원문 미반환
  const broken = conn('app_server', `${DB}_missing`);
  try {
    const u = await listMaskedLeads(deps(undefined, broken), who(OWNER, S(1), 'owner'));
    assert.deepEqual(u, { ok: false, code: 'UNAVAILABLE' });
  } finally {
    await broken.end({ timeout: 1 }).catch(() => {});
  }
});

// ---- PM 6913462268: HTTP 출처 분기 조합 → 어댑터 → withRoleOn(주입 소켓 실행기) → 실제 PG ----
// 주의: 아래 실행기는 시험용 Unix socket 주입 실행기다. 기본 withRole(db(), DATABASE_URL 접속)의 실제 연결 검증이 아니다.

test('P9 route 조합(db 출처·지정 폐기 DB 판정) → 실제 PG: owner 200 마스킹 목록, counselor 본인 건, 만료 세션 403, 상세 503', async () => {
  // 가짜 env 객체에만 NODE_ENV='test'를 둔다(실제 환경 파일·프로세스의 NODE_ENV는 바꾸지 않음)
  const env = { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: `postgres://app_server@127.0.0.1:${PORT}/${DB}`, NODE_ENV: 'test' };
  const mk = (identity: StaffIdentity): AdminLeadsDeps => ({
    env: () => env,
    mode: () => 'supabase',
    requireStaff: async () => identity,
    runInTransaction: (fn) => withRoleOn(app, 'staff', (tx) => fn(tx as unknown as SqlTag)),
    mockList: async () => new Response('mock', { status: 299 }),
    mockDetail: async () => new Response('mock', { status: 299 }),
  });
  const before = await counts();
  const o = await adminLeadsList(mk(who(OWNER, S(1), 'owner')), new Request('http://localhost/api/admin/leads?limit=2'));
  assert.equal(o.status, 200);
  assert.equal(o.headers.get('cache-control'), 'private, no-store');
  const ob = (await o.json()) as { data_source: string; items: { id: string }[] };
  assert.equal(ob.data_source, 'db');
  assert.deepEqual(ob.items.map((i) => i.id), [L(3), L(2)]);
  assert.ok(!SECRETS.some((m) => JSON.stringify(ob).includes(m)));
  const c = (await (await adminLeadsList(mk(who(CA, S(2), 'counselor')), new Request('http://localhost/api/admin/leads'))).json()) as { items: { id: string }[] };
  assert.deepEqual(c.items.map((i) => i.id), [L(1)]);
  const ex = await adminLeadsList(mk(who(OWNER, S(7), 'owner')), new Request('http://localhost/api/admin/leads'));
  assert.equal(ex.status, 403);
  assert.deepEqual(await ex.json(), { ok: false, code: 'FORBIDDEN' });
  const d = await adminLeadDetail(mk(who(OWNER, S(1), 'owner')));
  assert.equal(d.status, 503);
  assert.deepEqual(await counts(), before, '조회 전후 변화 없음');
});
