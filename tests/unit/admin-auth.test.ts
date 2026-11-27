// 관리자 인증 스위치와 로그인 절차(비밀번호 → TOTP → DB 세션). Supabase는 가짜 포트로 대체한다.
// 실제 Supabase Auth 동작 검증이 아니다(개발 프로젝트 설정 후 별도 확인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminAuthMode, adminMockVisible, isLocalDatabaseUrl } from '../../src/server/auth/adminAuthMode';
import { logoutFlow, passwordStep, totpStep, type AuthPort } from '../../src/server/auth/loginFlow';
import { StaffAuthError, type VerifiedClaims } from '../../src/server/auth/staffAssertion';
import { StaffSessionUnavailable } from '../../src/server/auth/staffSession';
import { classifyClaims } from '../../src/server/auth/authErrors';
import { LOGIN_MESSAGES, LOGOUT_MESSAGES, logoutNotice } from '../../src/content/adminLogin';

const FULL = {
  ADMIN_AUTH_MODE: 'supabase',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'x',
  FIDEON_STAFF_SIGNING_KEY: 'x',
  DATABASE_URL: 'x',
  SUPABASE_DB_CA_CERT: 'x', // 'x'는 원격으로 취급되므로 CA가 있어야 켜진다
};

test('스위치: 기본·오타·설정 누락·운영이면 꺼짐, 명시 + 설정 완비일 때만 켜짐', () => {
  assert.equal(adminAuthMode({}), 'disabled');
  assert.equal(adminAuthMode({ ...FULL, ADMIN_AUTH_MODE: 'true' }), 'disabled');
  for (const k of Object.keys(FULL).filter((k) => k !== 'ADMIN_AUTH_MODE')) {
    assert.equal(adminAuthMode({ ...FULL, [k]: ' ' }), 'disabled', k);
  }
  assert.equal(adminAuthMode({ ...FULL, VERCEL_ENV: 'production' }), 'disabled');
  assert.equal(adminAuthMode({ ...FULL, VERCEL_ENV: 'production', ADMIN_PRODUCTION_ENABLED: 'true' }), 'supabase');
  assert.equal(adminAuthMode({ ...FULL, K_SERVICE: 'bareun365', ADMIN_PRODUCTION_ENABLED: 'true' }), 'supabase');
  assert.equal(adminAuthMode({ ...FULL, K_SERVICE: 'bareun365', VERCEL_ENV: 'preview', ADMIN_PRODUCTION_ENABLED: 'true' }), 'disabled');
  assert.equal(adminAuthMode({ ...FULL, VERCEL_ENV: 'preview' }), 'supabase');
});

test('가상 데이터 관리자 화면: 인증 꺼짐 + 로컬 개발 서버에서만(preview·production 빌드는 잠금)', () => {
  assert.equal(adminMockVisible({ NODE_ENV: 'development' }), true);
  assert.equal(adminMockVisible({ NODE_ENV: 'production' }), false);
  assert.equal(adminMockVisible({ NODE_ENV: 'development', VERCEL: '1' }), false);
  assert.equal(adminMockVisible({ ...FULL, NODE_ENV: 'development' }), false);
  assert.equal(adminMockVisible({}), false);
});

test('스위치: 원격 DB인데 CA 인증서가 없으면 꺼짐(로그인 단계 DB 접속 실패 방지), 로컬 DB는 CA 없이 켜짐', () => {
  const REMOTE = 'postgresql://app_server.ref@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres';
  const LOCAL = 'postgres://app_server@127.0.0.1:54329/fideon_test';
  for (const ca of [undefined, '', '  \n']) {
    assert.equal(adminAuthMode({ ...FULL, DATABASE_URL: REMOTE, SUPABASE_DB_CA_CERT: ca }), 'disabled', `remote ca=${JSON.stringify(ca)}`);
    assert.equal(adminAuthMode({ ...FULL, DATABASE_URL: LOCAL, SUPABASE_DB_CA_CERT: ca }), 'supabase', `local ca=${JSON.stringify(ca)}`);
  }
  assert.equal(adminAuthMode({ ...FULL, DATABASE_URL: REMOTE }), 'supabase');
  assert.equal(adminAuthMode({ ...FULL, DATABASE_URL: REMOTE, SUPABASE_DB_CA_CERT: undefined, VERCEL_ENV: 'production' }), 'disabled');
});

test('로컬 DB 판단: 호스트가 정확히 localhost·127.0.0.1일 때만, 흉내·해석 실패·다른 프로토콜은 원격', () => {
  for (const u of ['postgres://u@localhost/x', 'postgresql://u@127.0.0.1:5432/x', 'postgres://u:p@localhost:5432/x']) assert.equal(isLocalDatabaseUrl(u), true, u);
  for (const u of [
    undefined, '', 'x', 'not a url',
    'postgres://u@127.0.0.1.example.com/x',
    'postgres://u@localhost.example.com:5432/x',
    'postgres://u:p@localhost:1@db.example.com:5432/x', // 비밀번호 안의 @localhost: 흉내
    'http://localhost/x',
    'postgres://u@0.0.0.0/x',
  ]) assert.equal(isLocalDatabaseUrl(u), false, String(u));
});

const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '10000000-0000-4000-8000-000000000001';

/** 가짜 Supabase: 등록 계정 1개(비밀번호 + 검증된 TOTP) */
function fakeAuth(opts: { totp?: boolean; verifyOk?: boolean; upgrade?: boolean; signOutFails?: boolean; clearFails?: boolean; session?: 'throw' | 'invalid' } = {}) {
  const calls: string[] = [];
  let aal: string | null = null;
  const port: AuthPort = {
    signInWithPassword: async (email, password) => {
      calls.push('signIn');
      if (email === 'staff@example.com' && password === 'correct-horse') { aal = 'aal1'; return true; }
      return false;
    },
    nextLevel: async () => (opts.totp === false ? 'aal1' : 'aal2'),
    verifiedTotpFactorId: async () => (opts.totp === false ? null : 'factor-1'),
    challengeAndVerify: async (_f, code) => {
      calls.push('verify');
      if (opts.verifyOk === false || code !== '123456') return false;
      if (opts.upgrade !== false) aal = 'aal2';
      return true;
    },
    session: async () => {
      if (opts.session === 'throw') throw new Error('AUTH_UNAVAILABLE');
      if (opts.session === 'invalid' && aal) return { kind: 'invalid' as const };
      return aal ? { kind: 'ok' as const, claims: { sub: USER, session_id: SESSION, aal } as VerifiedClaims } : { kind: 'none' as const };
    },
    signOut: async () => {
      calls.push('signOut');
      if (opts.signOutFails) throw new Error('AUTH_SIGNOUT_FAILED');
      aal = null;
    },
    clearLocalSession: async () => {
      calls.push('clear');
      if (opts.clearFails) throw new Error('cookie');
      aal = null;
    },
  };
  return { port, calls, aal: () => aal };
}

test('비밀번호 단계: 계정 없음·비밀번호 오류·TOTP 미등록·형식 오류는 모두 같은 오류(계정 존재 비노출)', async () => {
  const cases = [
    [{ email: 'nobody@example.com', password: 'x' }, {}],
    [{ email: 'staff@example.com', password: 'wrong' }, {}],
    [{ email: 'staff@example.com', password: 'correct-horse' }, { totp: false }],
    [{ email: 'not-an-email', password: 'x' }, {}],
    [{ email: null, password: undefined }, {}],
  ] as const;
  for (const [input, opts] of cases) {
    const f = fakeAuth(opts);
    assert.deepEqual(await passwordStep(input, f.port), { step: 'password', error: 'INVALID_CREDENTIALS' });
    assert.equal(f.aal(), null, '비밀번호만으로 로그인 상태가 남지 않음');
  }
  const ok = fakeAuth();
  assert.deepEqual(await passwordStep({ email: ' staff@example.com ', password: 'correct-horse' }, ok.port), { step: 'totp' });
});

test('TOTP 단계: aal1에서는 DB 세션을 열지 않고, 성공 후 정확히 1회 연다', async () => {
  const f = fakeAuth();
  await passwordStep({ email: 'staff@example.com', password: 'correct-horse' }, f.port);
  const opened: VerifiedClaims[] = [];
  const open = async (c: VerifiedClaims) => { opened.push(c); return 'owner'; };
  for (const code of ['', '12345', 'abcdef', '1234567']) {
    assert.deepEqual(await totpStep({ code }, f.port, open), { step: 'totp', error: 'INVALID_CODE' });
  }
  assert.deepEqual(await totpStep({ code: '000000' }, f.port, open), { step: 'totp', error: 'INVALID_CODE' });
  assert.equal(opened.length, 0);
  assert.deepEqual(await totpStep({ code: '123456' }, f.port, open), { step: 'done', role: 'owner' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].aal, 'aal2');
});

test('TOTP 단계: 비밀번호 단계 없이 바로 오면 거부, 검증 후에도 aal2가 아니면 세션 열지 않고 로그아웃', async () => {
  const open = async () => { throw new Error('must not open'); };
  assert.deepEqual(await totpStep({ code: '123456' }, fakeAuth().port, open), { step: 'password', error: 'SESSION_EXPIRED' });
  const f = fakeAuth({ upgrade: false });
  await passwordStep({ email: 'staff@example.com', password: 'correct-horse' }, f.port);
  assert.deepEqual(await totpStep({ code: '123456' }, f.port, open), { step: 'password', error: 'SESSION_EXPIRED' });
  assert.equal(f.aal(), null);
});

test('DB가 거부(403)하면 ACCESS_DENIED, DB 장애면 UNAVAILABLE — 둘 다 Supabase 로그인도 끝냄', async () => {
  for (const [err, code] of [[new StaffAuthError(403, 'FORBIDDEN'), 'ACCESS_DENIED'], [new StaffSessionUnavailable(), 'UNAVAILABLE'], [new Error('config'), 'UNAVAILABLE']] as const) {
    const f = fakeAuth();
    await passwordStep({ email: 'staff@example.com', password: 'correct-horse' }, f.port);
    assert.deepEqual(await totpStep({ code: '123456' }, f.port, async () => { throw err; }), { step: 'password', error: code });
    assert.equal(f.aal(), null);
  }
});

test('로그아웃: DB 폐기·Auth 로그아웃 성공/실패 조합마다 결과를 숨기지 않음', async () => {
  const cases = [
    { db: true, auth: true, clear: true, want: 'complete', calls: ['signOut'] },
    { db: false, auth: true, clear: true, want: 'db_unconfirmed', calls: ['signOut'] },
    { db: true, auth: false, clear: true, want: 'auth_unconfirmed', calls: ['signOut', 'clear'] },
    { db: false, auth: false, clear: true, want: 'both_unconfirmed', calls: ['signOut', 'clear'] },
    { db: true, auth: false, clear: false, want: 'local_not_cleared', calls: ['signOut', 'clear'] },
    { db: false, auth: false, clear: false, want: 'local_not_cleared', calls: ['signOut', 'clear'] },
  ] as const;
  for (const c of cases) {
    const f = fakeAuth({ signOutFails: !c.auth, clearFails: !c.clear });
    await passwordStep({ email: 'staff@example.com', password: 'correct-horse' }, f.port);
    await totpStep({ code: '123456' }, f.port, async () => 'owner');
    const before = f.calls.length;
    const order: string[] = [];
    const out = await logoutFlow(f.port, async (cl) => {
      order.push(`revoke:${cl.aal}`);
      if (!c.db) throw Object.assign(new StaffAuthError(403, 'FORBIDDEN'), { detail: 'private' });
    });
    assert.equal(out, c.want, JSON.stringify(c));
    assert.deepEqual(order, ['revoke:aal2'], 'DB 폐기를 먼저 시도');
    assert.deepEqual(f.calls.slice(before), c.calls);
    assert.equal(f.aal() === null, c.clear || c.auth, '로컬 로그인 정보 제거 여부');
  }
  // 이미 로그인 정보가 없으면 폐기할 세션도 없다: DB 호출 없이 complete
  const none = fakeAuth();
  assert.equal(await logoutFlow(none.port, async () => { throw new Error('must not call'); }), 'complete');
});

test('로그아웃: 세션 조회 장애·검증 실패는 미로그인으로 오인하지 않음(complete 금지), signOut 성공/실패 조합', async () => {
  for (const session of ['throw', 'invalid'] as const) {
    for (const signOutFails of [false, true]) {
      const f = fakeAuth({ signOutFails });
      await passwordStep({ email: 'staff@example.com', password: 'correct-horse' }, f.port);
      await totpStep({ code: '123456' }, f.port, async () => 'owner');
      const broken = { ...f.port, session: fakeAuth({ session }).port.session };
      if (session === 'invalid') broken.session = async () => ({ kind: 'invalid' as const });
      let revoked = 0;
      const out = await logoutFlow(broken, async () => { revoked++; });
      assert.equal(revoked, 0, '검증된 세션 없이 폐기를 호출하지 않음');
      assert.equal(out, signOutFails ? 'both_unconfirmed' : 'db_unconfirmed', `${session}/${signOutFails}`);
      assert.equal(f.aal(), null, '로컬 로그인 정보는 지움');
    }
  }
});

test('classifyClaims: 세션 없음·검증 실패·정상 구분, 장애는 원문 없는 예외', () => {
  assert.deepEqual(classifyClaims({ data: null, error: null }), { kind: 'none' });
  assert.deepEqual(classifyClaims({ data: null, error: { name: 'AuthSessionMissingError', status: 400 } }), { kind: 'none' });
  assert.deepEqual(classifyClaims({ data: null, error: { name: 'AuthInvalidJwtError' } }), { kind: 'invalid' });
  assert.deepEqual(classifyClaims({ data: null, error: { name: 'AuthApiError', status: 401 } }), { kind: 'invalid' });
  assert.deepEqual(classifyClaims({ data: { claims: { sub: USER } }, error: null }), { kind: 'ok', claims: { sub: USER } });
  for (const error of [{ name: 'AuthRetryableFetchError', status: 0, message: 'secret-detail' }, { name: 'X', status: 503, message: 'secret-detail' }, { name: 'X', message: 'secret-detail' }]) {
    assert.throws(() => classifyClaims({ data: null, error }), (e: Error) => e.message === 'AUTH_UNAVAILABLE' && !('cause' in e));
  }
});

test('로그인 실패 경로에서 Supabase 로그아웃이 실패하면 로컬 쿠키를 지운다', async () => {
  const f = fakeAuth({ signOutFails: true });
  await passwordStep({ email: 'staff@example.com', password: 'correct-horse' }, f.port);
  assert.deepEqual(await totpStep({ code: '123456' }, f.port, async () => { throw new StaffAuthError(403, 'FORBIDDEN'); }), { step: 'password', error: 'ACCESS_DENIED' });
  assert.deepEqual(f.calls.slice(-2), ['signOut', 'clear']);
  assert.equal(f.aal(), null);
});

test('로그아웃 경고 문구: 정해진 값만 표시, 나머지 주소 값은 무시', () => {
  assert.equal(logoutNotice('complete'), null);
  assert.equal(logoutNotice('<script>'), null);
  assert.equal(logoutNotice(['db_unconfirmed']), null);
  assert.equal(logoutNotice('__proto__'), null);
  for (const k of ['db_unconfirmed', 'auth_unconfirmed', 'both_unconfirmed', 'local_not_cleared']) assert.ok(logoutNotice(k));
  assert.ok(!/완료했습니다|로그아웃되었습니다/.test(Object.values(LOGOUT_MESSAGES).join(' ')), '미완료를 완료처럼 표현하지 않음');
});

test('화면 문구는 계정 존재·내부 사유를 드러내지 않고, 로그인 화면 코드는 서버 모듈을 import하지 않음', () => {
  for (const m of Object.values(LOGIN_MESSAGES)) assert.ok(!/존재|등록되지|없는 계정|TOTP|DB|SQL/.test(m), m);
  const form = readFileSync('src/app/admin/login/LoginForm.tsx', 'utf8');
  assert.ok(!/@\/server\//.test(form), 'LoginForm이 서버 모듈을 import함');
  const mw = readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /matcher: \['\/admin', '\/admin\/:path\*'\]/);
  assert.match(mw, /adminMiddleware\(/);
  assert.match(readFileSync('src/server/auth/adminMiddleware.ts', 'utf8'), /const NO_STORE = 'private, no-store'/);
});
