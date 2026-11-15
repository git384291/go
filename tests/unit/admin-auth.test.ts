// 관리자 인증 스위치와 로그인 절차(비밀번호 → TOTP → DB 세션). Supabase는 가짜 포트로 대체한다.
// 실제 Supabase Auth 동작 검증이 아니다(개발 프로젝트 설정 후 별도 확인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminAuthMode, adminMockVisible } from '../../src/server/auth/adminAuthMode';
import { logoutFlow, passwordStep, totpStep, type AuthPort } from '../../src/server/auth/loginFlow';
import { StaffAuthError, type VerifiedClaims } from '../../src/server/auth/staffAssertion';
import { StaffSessionUnavailable } from '../../src/server/auth/staffSession';
import { LOGIN_MESSAGES } from '../../src/content/adminLogin';

const FULL = {
  ADMIN_AUTH_MODE: 'supabase',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'x',
  FIDEON_STAFF_SIGNING_KEY: 'x',
  DATABASE_URL: 'x',
};

test('스위치: 기본·오타·설정 누락·운영이면 꺼짐, 명시 + 설정 완비일 때만 켜짐', () => {
  assert.equal(adminAuthMode({}), 'disabled');
  assert.equal(adminAuthMode({ ...FULL, ADMIN_AUTH_MODE: 'true' }), 'disabled');
  for (const k of Object.keys(FULL).filter((k) => k !== 'ADMIN_AUTH_MODE')) {
    assert.equal(adminAuthMode({ ...FULL, [k]: ' ' }), 'disabled', k);
  }
  assert.equal(adminAuthMode({ ...FULL, VERCEL_ENV: 'production' }), 'disabled');
  assert.equal(adminAuthMode({ ...FULL, VERCEL_ENV: 'preview' }), 'supabase');
});

test('가상 데이터 관리자 화면: 인증 꺼짐 + 로컬 개발 서버에서만(preview·production 빌드는 잠금)', () => {
  assert.equal(adminMockVisible({ NODE_ENV: 'development' }), true);
  assert.equal(adminMockVisible({ NODE_ENV: 'production' }), false);
  assert.equal(adminMockVisible({ NODE_ENV: 'development', VERCEL: '1' }), false);
  assert.equal(adminMockVisible({ ...FULL, NODE_ENV: 'development' }), false);
  assert.equal(adminMockVisible({}), false);
});

const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '10000000-0000-4000-8000-000000000001';

/** 가짜 Supabase: 등록 계정 1개(비밀번호 + 검증된 TOTP) */
function fakeAuth(opts: { totp?: boolean; verifyOk?: boolean; upgrade?: boolean } = {}) {
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
    claims: async (): Promise<VerifiedClaims | null> => (aal ? { sub: USER, session_id: SESSION, aal } : null),
    signOut: async () => { calls.push('signOut'); aal = null; },
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

test('로그아웃: DB 세션 폐기 후 Supabase 로그아웃, 폐기 실패해도 로그아웃은 진행', async () => {
  for (const fail of [false, true]) {
    const f = fakeAuth();
    await passwordStep({ email: 'staff@example.com', password: 'correct-horse' }, f.port);
    await totpStep({ code: '123456' }, f.port, async () => 'owner');
    const order: string[] = [];
    await logoutFlow(f.port, async (c) => { order.push(`revoke:${c.aal}`); if (fail) throw new StaffAuthError(403, 'FORBIDDEN'); });
    assert.deepEqual(order, ['revoke:aal2']);
    assert.equal(f.calls.at(-1), 'signOut');
    assert.equal(f.aal(), null);
  }
});

test('화면 문구는 계정 존재·내부 사유를 드러내지 않고, 로그인 화면 코드는 서버 모듈을 import하지 않음', () => {
  for (const m of Object.values(LOGIN_MESSAGES)) assert.ok(!/존재|등록되지|없는 계정|TOTP|DB|SQL/.test(m), m);
  const form = readFileSync('src/app/admin/login/LoginForm.tsx', 'utf8');
  assert.ok(!/@\/server\//.test(form), 'LoginForm이 서버 모듈을 import함');
  const mw = readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /'Cache-Control', 'private, no-store'/);
  assert.match(mw, /matcher: \['\/admin', '\/admin\/:path\*'\]/);
});
