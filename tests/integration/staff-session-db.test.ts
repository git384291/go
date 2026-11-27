// 실제 로컬 가상 PostgreSQL에서 관리자 세션 서비스 + withRole SQL 배선·롤백을 검증한다.
// scripts/db-test.sh가 가상 DB(fideon_test)를 만든 뒤 실행한다. 운영 DB·실제 고객정보를 쓰지 않는다.
// 가짜 DB 포트가 아니라 앱과 같은 코드(staffSessionDb.ts → withRoleOn → api.* 함수)를 실행한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { withRoleOn, type DbRole } from '../../src/server/db/client';
import { authorizeStaffWithDb, openStaffSessionWithDb, revokeStaffSessionWithDb, type StaffTx } from '../../src/server/auth/staffSessionDb';
import { StaffSessionUnavailable } from '../../src/server/auth/staffSession';
import { StaffAuthError, staffSessionOpenAssertion } from '../../src/server/auth/staffAssertion';

const SOCK = process.env.FIDEON_TEST_PGSOCK ?? '/tmp';
const PORT = Number(process.env.FIDEON_TEST_PGPORT ?? 54329);
const DB = process.env.FIDEON_TEST_PGDATABASE ?? 'fideon_test';
const conn = (user: string, port = PORT) =>
  postgres({ path: `${SOCK}/.s.PGSQL.${port}`, user, database: DB, prepare: false, max: 2, connect_timeout: 3, onnotice: () => {} });

const app = conn('app_server'); // 앱과 같은 로그인 역할(테이블 직접 권한 없음)
const admin = conn('postgres'); // 결과 확인 전용(시험 DB 소유자)
after(async () => { await app.end(); await admin.end(); });

const key = { keyId: 1, secret: Buffer.alloc(32, 0x11) }; // db/seed/test_seed.sql의 가상 키
const OWNER = '00000000-0000-4000-8000-000000000001';
const COUNSELOR = '00000000-0000-4000-8000-000000000002';
const INACTIVE = '00000000-0000-4000-8000-000000000003';
const OWNER_SESSION = '10000000-0000-4000-8000-000000000001';
const EXPIRED = '10000000-0000-4000-8000-000000000006';
const REVOKED = '10000000-0000-4000-8000-000000000007';

const staff = (role: DbRole = 'staff'): StaffTx => (fn) => withRoleOn(app, role, fn);
const claims = (sub: string, session: string) => ({ sub, session_id: session, aal: 'aal2' });
const forbidden = (e: unknown) => e instanceof StaffAuthError && e.status === 403 && e.message === 'FORBIDDEN';

async function state(session: string) {
  const [r] = await admin`
    select (select count(*)::int from core.audit_logs) as audits,
           (select count(*)::int from security.staff_sessions) as sessions,
           (select user_id::text from security.staff_sessions where id = ${session}::uuid) as owner,
           (select revoked_at is not null from security.staff_sessions where id = ${session}::uuid) as revoked`;
  return r as { audits: number; sessions: number; owner: string | null; revoked: boolean | null };
}

test('I1 withRoleOn: 트랜잭션 안에서만 app_staff·시간 제한 적용, 끝나면 원래 역할', async () => {
  const inside = await withRoleOn(app, 'staff', (tx) =>
    tx`select current_user::text as u, current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as it`);
  assert.deepEqual({ ...inside[0] }, { u: 'app_staff', st: '5s', it: '10s' });
  const [outside] = await app`select current_user::text as u`;
  assert.equal(outside.u, 'app_server');
});

test('I2 정상 등록: 새 세션 1건 + 감사 기록 1건, 이후 일반 요청 통과', async () => {
  const s = randomUUID();
  const before = await state(s);
  const id = await openStaffSessionWithDb(claims(OWNER, s), key, staff());
  assert.deepEqual({ actor: id.actor, session: id.session, role: id.role }, { actor: OWNER, session: s, role: 'owner' });
  const afterOpen = await state(s);
  assert.equal(afterOpen.sessions, before.sessions + 1);
  assert.equal(afterOpen.audits, before.audits + 1);
  assert.equal(afterOpen.owner, OWNER);
  const [log] = await admin`select action, actor_id::text as actor from core.audit_logs where target_id = ${s}::uuid`;
  assert.deepEqual({ ...log }, { action: 'staff.session_open', actor: OWNER });
  assert.equal((await authorizeStaffWithDb(claims(OWNER, s), key, staff())).role, 'owner');
});

test('I3 롤백 증명: 폐기된 세션 재등록 — 등록 함수 단독은 감사 기록을 남기지만, 서비스는 거부하고 전부 롤백', async () => {
  // 대조군: 같은 트랜잭션에서 api.staff_session_open만 실행하면 성공하고 감사 기록이 1건 늘어난다(그 뒤 수동 롤백).
  const open = staffSessionOpenAssertion(claims(OWNER, REVOKED), key);
  const before = await state(REVOKED);
  await assert.rejects(admin.begin(async (tx) => {
    const [r] = await tx`select api.staff_session_open(${open.actor}::uuid, ${open.session}::uuid, ${open.token}) as role`;
    assert.equal(r.role, 'owner');
    const [c] = await tx`select count(*)::int as n from core.audit_logs`;
    assert.equal(c.n, before.audits + 1);
    throw new Error('control-rollback');
  }), /control-rollback/);
  // 실제 서비스: 등록 직후 whoami가 거부 → 같은 트랜잭션 전체 롤백
  await assert.rejects(openStaffSessionWithDb(claims(OWNER, REVOKED), key, staff()), forbidden);
  assert.deepEqual(await state(REVOKED), before);
});

test('I4 12시간 지난 세션 재등록 거부, 세션·감사 기록 변화 없음', async () => {
  const before = await state(EXPIRED);
  await assert.rejects(openStaffSessionWithDb(claims(OWNER, EXPIRED), key, staff()), forbidden);
  await assert.rejects(authorizeStaffWithDb(claims(OWNER, EXPIRED), key, staff()), forbidden);
  assert.deepEqual(await state(EXPIRED), before);
});

test('I5 다른 사용자의 세션 ID로 등록·요청 거부, 소유자 그대로', async () => {
  const before = await state(OWNER_SESSION);
  await assert.rejects(openStaffSessionWithDb(claims(COUNSELOR, OWNER_SESSION), key, staff()), forbidden);
  await assert.rejects(authorizeStaffWithDb(claims(COUNSELOR, OWNER_SESSION), key, staff()), forbidden);
  const now = await state(OWNER_SESSION);
  assert.deepEqual(now, before);
  assert.equal(now.owner, OWNER);
});

test('I6 비활성 직원·미등록 사용자: 새 세션도 만들지 않고 감사 기록 없음', async () => {
  for (const user of [INACTIVE, randomUUID()]) {
    const s = randomUUID();
    const before = await state(s);
    await assert.rejects(openStaffSessionWithDb(claims(user, s), key, staff()), forbidden);
    const now = await state(s);
    assert.deepEqual(now, before);
    assert.equal(now.owner, null);
  }
});

test('I7 다른 서버 키로 서명한 요청 거부, 변화 없음', async () => {
  const s = randomUUID();
  const before = await state(s);
  await assert.rejects(openStaffSessionWithDb(claims(OWNER, s), { keyId: 1, secret: Buffer.alloc(32, 0x12) }, staff()), forbidden);
  assert.deepEqual(await state(s), before);
});

test('I8 로그아웃: 폐기 + 감사 기록 1건, 이후 요청·재로그아웃·재등록 모두 거부', async () => {
  const s = randomUUID();
  await openStaffSessionWithDb(claims(OWNER, s), key, staff());
  const before = await state(s);
  await revokeStaffSessionWithDb(claims(OWNER, s), key, staff());
  const now = await state(s);
  assert.equal(now.revoked, true);
  assert.equal(now.audits, before.audits + 1);
  await assert.rejects(authorizeStaffWithDb(claims(OWNER, s), key, staff()), forbidden);
  await assert.rejects(revokeStaffSessionWithDb(claims(OWNER, s), key, staff()), forbidden);
  await assert.rejects(openStaffSessionWithDb(claims(OWNER, s), key, staff()), forbidden);
  assert.deepEqual(await state(s), now);
});

test('I9 권한 구성 오류(관리자 함수를 공개 역할로 호출): 내부 SQL 정보 없이 403, 변화 없음', async () => {
  const s = randomUUID();
  const before = await state(s);
  await assert.rejects(openStaffSessionWithDb(claims(OWNER, s), key, staff('public')), (e) => {
    assert.ok(forbidden(e));
    for (const p of ['cause', 'query', 'parameters', 'detail', 'hint']) assert.equal(p in (e as object), false, p);
    return true;
  });
  assert.deepEqual(await state(s), before);
});

test('I10 DB 장애(연결 불가): StaffSessionUnavailable, 접속 경로·서명·원인 비노출', async () => {
  const dead = conn('app_server', PORT + 1); // 서버가 없는 포트
  try {
    await assert.rejects(authorizeStaffWithDb(claims(OWNER, OWNER_SESSION), key, (fn) => withRoleOn(dead, 'staff', fn)), (e) => {
      assert.ok(e instanceof StaffSessionUnavailable);
      assert.equal((e as Error).message, 'STAFF_SESSION_UNAVAILABLE');
      for (const p of ['cause', 'query', 'parameters', 'address', 'port', 'path']) assert.equal(p in (e as object), false, p);
      const text = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`;
      assert.ok(!text.includes(SOCK + '/.s.PGSQL'), '접속 경로 노출');
      assert.ok(!/\d+\.\d+\.[0-9a-f]{64}/.test(text), '서명 토큰 노출');
      assert.ok(!text.includes(OWNER_SESSION), '세션 ID 노출');
      return true;
    });
  } finally {
    await dead.end({ timeout: 1 });
  }
});
