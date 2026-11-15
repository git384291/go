// 관리자 middleware 경로 시험: 실제 next/server의 NextRequest·NextResponse로 adminMiddleware를 실행한다.
// Supabase 클라이언트만 가짜로 바꾼다(네트워크 없음). next 미설치 환경(대체 모듈)에서는 건너뛰고, 통과로 세지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
let realNext = true;
try { req.resolve('next/package.json'); } catch { realNext = false; }
const skip = realNext ? false : 'next 미설치(대체 모듈) — CI·Mac(npm ci 후)에서 실행';

const ON = {
  ADMIN_AUTH_MODE: 'supabase',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'x',
  FIDEON_STAFF_SIGNING_KEY: 'x',
  DATABASE_URL: 'x',
};

async function load() {
  const { NextRequest } = await import('next/server');
  const mw = await import('../../src/server/auth/adminMiddleware');
  const request = (path = '/admin') => new NextRequest(`http://localhost${path}`, { headers: { cookie: 'sb-proj-auth-token=old' } });
  return { ...mw, request };
}

type Fake = Parameters<Awaited<ReturnType<typeof load>>['adminMiddleware']>[1];
const client = (getClaims: (setAll: (l: { name: string; value: string }[]) => void) => Promise<{ error: unknown }>): { fake: Fake; created: () => number } => {
  let n = 0;
  return {
    fake: (cookies) => { n++; return { auth: { getClaims: () => getClaims(cookies.setAll) } }; },
    created: () => n,
  };
};
const passedThrough = (r: Response) => r.headers.get('x-middleware-next') === '1';

test('M1 인증 꺼짐: Supabase 호출 없이 통과, no-store', { skip }, async () => {
  const { adminMiddleware, request } = await load();
  const c = client(async () => { throw new Error('must not call'); });
  const r = await adminMiddleware(request(), c.fake, {});
  assert.equal(c.created(), 0);
  assert.ok(passedThrough(r));
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});

test('M2 정상 갱신: 갱신 쿠키를 응답에 싣고 통과, no-store', { skip }, async () => {
  const { adminMiddleware, request } = await load();
  const c = client(async (setAll) => { setAll([{ name: 'sb-proj-auth-token', value: 'new' }]); return { error: null }; });
  const r = await adminMiddleware(request(), c.fake, ON);
  assert.ok(passedThrough(r));
  assert.match(r.headers.get('set-cookie') ?? '', /sb-proj-auth-token=new/);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});

test('M3 로그인 안 됨·토큰 무효는 장애가 아님: 통과(화면이 DB 확인 후 로그인으로 보냄)', { skip }, async () => {
  const { adminMiddleware, request } = await load();
  for (const error of [null, { name: 'AuthSessionMissingError', status: 400 }, { name: 'AuthApiError', status: 401 }, { name: 'AuthInvalidJwtError' }]) {
    const r = await adminMiddleware(request(), client(async () => ({ error })).fake, ON);
    assert.ok(passedThrough(r), JSON.stringify(error));
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
  }
});

test('M4 인증 서버 장애(예외·재시도 오류·5xx·상태 없음): 보호 화면 미진입, 일반화된 503, 원문 비노출', { skip }, async () => {
  const { adminMiddleware, request, ADMIN_UNAVAILABLE_BODY } = await load();
  const secret = 'private-network-detail token=abc.def.ghi';
  const cases = [
    client(async () => { throw new Error(secret); }),
    client(async () => ({ error: { name: 'AuthRetryableFetchError', status: 0, message: secret } })),
    client(async () => ({ error: { name: 'AuthApiError', status: 503, message: secret } })),
    client(async () => ({ error: { name: 'AuthUnknownError', message: secret } })),
    { fake: (() => { throw new Error(secret); }) as Fake, created: () => 1 },
  ];
  for (const path of ['/admin', '/admin/login']) {
    for (const c of cases) {
      const r = await adminMiddleware(request(path), c.fake, ON);
      assert.equal(r.status, 503);
      assert.ok(!passedThrough(r));
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
      const body = await r.text();
      assert.equal(body, ADMIN_UNAVAILABLE_BODY);
      assert.ok(![...r.headers.values()].some((v) => v.includes('private-network-detail')));
    }
  }
});

test('M5 갱신 쿠키를 받은 뒤 장애가 나도 503 응답에 쿠키 보존', { skip }, async () => {
  const { adminMiddleware, request } = await load();
  const c = client(async (setAll) => {
    setAll([{ name: 'sb-proj-auth-token', value: 'refreshed' }]);
    throw new Error('network after refresh');
  });
  const r = await adminMiddleware(request(), c.fake, ON);
  assert.equal(r.status, 503);
  assert.match(r.headers.get('set-cookie') ?? '', /sb-proj-auth-token=refreshed/);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});

test('M6 isAuthOutage 판정', { skip }, async () => {
  const { isAuthOutage } = await load();
  assert.equal(isAuthOutage(null), false);
  assert.equal(isAuthOutage({ name: 'AuthSessionMissingError', status: 400 }), false);
  assert.equal(isAuthOutage({ name: 'AuthApiError', status: 401 }), false);
  assert.equal(isAuthOutage({ name: 'AuthRetryableFetchError', status: 400 }), true);
  assert.equal(isAuthOutage({ name: 'X', status: 502 }), true);
  assert.equal(isAuthOutage({ name: 'X' }), true);
});
