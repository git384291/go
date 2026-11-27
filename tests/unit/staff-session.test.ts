import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeStaffSession, establishStaffSession, revokeStaffSession, StaffSessionUnavailable, type StaffSessionStore } from '../../src/server/auth/staffSession';
import { StaffAuthError, type StaffAuth } from '../../src/server/auth/staffAssertion';

const actor = '00000000-0000-4000-8000-000000000001';
const session = '10000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const claims = { sub: actor, session_id: session, aal: 'aal2' };
const key = { keyId: 1, secret: Buffer.alloc(32, 0x11) };
const valid = [{ user_id: actor, role: 'owner' }];
const forbidden = (error: unknown) => error instanceof StaffAuthError && error.status === 403 && error.message === 'FORBIDDEN';

test('관리자 요청: aal1이면 DB 조회 전에 거부', async () => {
  let calls = 0;
  await assert.rejects(authorizeStaffSession({ ...claims, aal: 'aal1' }, key, async () => { calls++; return valid; }), StaffAuthError);
  assert.equal(calls, 0);
});

test('관리자 요청: DB가 확인한 본인·허용 역할만 통과', async () => {
  for (const role of ['owner', 'counselor', 'policy_editor', 'reviewer']) {
    const identity = await authorizeStaffSession(claims, key, async (auth) => {
      assert.equal(auth.actor, actor); assert.equal(auth.session, session);
      return [{ user_id: actor, role }];
    });
    assert.equal(identity.role, role);
  }
});

test('관리자 요청: 다른 사용자·알 수 없는 역할·누락·여러 행·손상 응답은 거부', async () => {
  for (const rows of [[], null, {}, [null], [1], [{}], [{ user_id: other, role: 'owner' }], [{ user_id: actor, role: 'admin' }], [...valid, ...valid]]) {
    await assert.rejects(authorizeStaffSession(claims, key, async () => rows), forbidden);
  }
});

test('관리자 요청: 폐기·만료 등 DB의 권한 거부를 일반 오류로 바꾸고 허용하지 않음', async () => {
  const refusal = Object.assign(new Error('private SQL detail'), { code: '42501' });
  await assert.rejects(authorizeStaffSession(claims, key, async () => { throw refusal; }), forbidden);
});

test('관리자 요청: DB 장애를 거부하고 내부 쿼리·서명 파라미터를 제거', async () => {
  const outage = Object.assign(new Error('private DB detail'), { query: 'private SQL', parameters: ['private assertion'] });
  await assert.rejects(authorizeStaffSession(claims, key, async () => { throw outage; }), (error) => {
    assert.ok(error instanceof StaffSessionUnavailable);
    assert.equal(error.message, 'STAFF_SESSION_UNAVAILABLE');
    for (const property of ['cause', 'query', 'parameters']) assert.equal(property in error, false);
    return true;
  });
});

test('관리자 요청: 대문자 UUID 클레임은 DB의 정규화된 본인 ID와 일치', async () => {
  const user = 'abcdefab-0000-4000-8000-abcdefabcdef';
  const id = 'abcdefab-1111-4000-8000-abcdefabcdef';
  const identity = await authorizeStaffSession({ sub: user.toUpperCase(), session_id: id.toUpperCase(), aal: 'aal2' }, key, async (auth) => {
    assert.equal(auth.actor, user); assert.equal(auth.session, id);
    return [{ user_id: user, role: 'owner' }];
  });
  assert.equal(identity.actor, user);
});

test('세션 등록: aal1·잘못된 ID는 트랜잭션 시작 전 거부', async () => {
  let transactions = 0;
  for (const invalid of [{ ...claims, aal: 'aal1' }, { ...claims, sub: 'invalid' }, { ...claims, session_id: undefined }]) {
    await assert.rejects(establishStaffSession(invalid, key, async () => { transactions++; throw new Error('must not connect'); }), StaffAuthError);
  }
  assert.equal(transactions, 0);
});

test('세션 등록: 열기와 whoami가 같은 트랜잭션에서 순서대로 성공해야 완료', async () => {
  const events: string[] = [];
  let opening: StaffAuth | undefined;
  const result = await establishStaffSession(claims, key, async (run) => {
    events.push('begin');
    const identity = await run({
      open: async (auth) => { events.push('open'); opening = auth; },
      whoami: async (auth) => {
        events.push('whoami');
        assert.equal(auth.actor, opening?.actor); assert.equal(auth.session, opening?.session);
        assert.notEqual(auth.token, opening?.token, '세션 열기와 요청 서명의 목적 분리');
        return valid;
      },
    });
    events.push('commit');
    return identity;
  });
  assert.equal(result.role, 'owner');
  assert.deepEqual(events, ['begin', 'open', 'whoami', 'commit']);
});

test('세션 등록: open이 성공해도 whoami 거부 시 트랜잭션 호출자에 실패 전달', async () => {
  const events: string[] = [];
  await assert.rejects(establishStaffSession(claims, key, async (run) => {
    try {
      const identity = await run({ open: async () => { events.push('open'); }, whoami: async () => [] });
      events.push('commit'); return identity;
    } catch (error) { events.push('rollback'); throw error; }
  }), forbidden);
  assert.deepEqual(events, ['open', 'rollback']);
});

test('세션 등록: open의 DB 거부 후 whoami를 호출하지 않음', async () => {
  let lookups = 0;
  const store: StaffSessionStore = {
    open: async () => { throw Object.assign(new Error('private SQL detail'), { code: '42501' }); },
    whoami: async () => { lookups++; return valid; },
  };
  await assert.rejects(establishStaffSession(claims, key, (run) => run(store)), forbidden);
  assert.equal(lookups, 0);
});

test('로그아웃: aal1이면 DB 호출 없이 거부, 정상이면 본인 서명으로 1회 호출', async () => {
  let calls = 0;
  await assert.rejects(revokeStaffSession({ ...claims, aal: 'aal1' }, key, async () => { calls++; }), StaffAuthError);
  assert.equal(calls, 0);
  await revokeStaffSession(claims, key, async (auth) => { calls++; assert.equal(auth.actor, actor); assert.equal(auth.session, session); });
  assert.equal(calls, 1);
});

test('로그아웃: 이미 폐기·만료(42501)는 403, DB 장애는 정보 없는 오류', async () => {
  await assert.rejects(revokeStaffSession(claims, key, async () => { throw Object.assign(new Error('private'), { code: '42501' }); }), forbidden);
  await assert.rejects(revokeStaffSession(claims, key, async () => { throw Object.assign(new Error('private'), { query: 'q' }); }), (e) => {
    assert.ok(e instanceof StaffSessionUnavailable); assert.equal('query' in e, false); return true;
  });
});
