// PHASE 1 최종 검수 보완: 상담 신청 API 경로(POST /api/leads)의 예약 상품 차단을 HTTP 응답 수준에서 정확히 검증한다.
//
// 왜 E2E가 아닌 이 시험에서 PRODUCT_NOT_ACTIVE를 보나
//   - API는 '수집 차단' 검사를 가장 먼저 한다. 수집을 끈 E2E 서버에서는 모든 신청이 503 LEAD_INTAKE_DISABLED가 된다.
//   - 403 PRODUCT_NOT_ACTIVE를 보려면 수집 차단을 통과해야 하는데, 서버를 수집 모드로 띄우지 않는다(고객정보 수집 비활성 원칙).
//   - 그래서 같은 경로 함수(실제 route.ts)를 이 프로세스 안에서 직접 호출한다. 서버·포트·DB·외부 호출 없음.
//
// 안전 장치
//   - process.env는 이 시험 프로세스 안에서만 바꾼다. DATABASE_URL은 열리지 않는 로컬 포트(1)를 가리킨다.
//     예약 상품 차단이 깨져 DB까지 가면 연결 실패 → 500이 되어 시험이 실패한다(저장은 불가능).
//   - 외부 요청(fetch)은 가짜 함수로 바꿔 횟수만 센다. 예약 상품은 Turnstile 확인 전에 거부되어야 하므로 0회여야 한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = ['LEAD_INTAKE_MODE', 'DATABASE_URL', 'VERCEL_ENV', 'TURNSTILE_SECRET_KEY', 'PUBLIC_HOSTNAME'] as const;
const saved: Record<string, string | undefined> = {};
let fetchCalls = 0;
const botFail = () => new Response(JSON.stringify({ success: false }), { status: 200, headers: { 'content-type': 'application/json' } });
// 가짜 봇 확인 응답(시험별로 바꾼다). 기본은 확인 실패
let botReply: () => Response | Promise<Response> = botFail;
const realFetch = globalThis.fetch;

type Post = (req: Request) => Promise<Response>;
let POST: Post;

function setGate(open: boolean) {
  if (open) {
    process.env.LEAD_INTAKE_MODE = 'local';
    process.env.DATABASE_URL = 'postgresql://route_test@127.0.0.1:1/route_test_never_used';
  } else {
    delete process.env.LEAD_INTAKE_MODE;
  }
  delete process.env.VERCEL_ENV;
  process.env.TURNSTILE_SECRET_KEY = 'test-only-turnstile-placeholder';
}

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return botReply();
  }) as typeof fetch;
  ({ POST } = (await import('../../src/app/api/leads/route')) as { POST: Post });
});

after(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const base = {
  name: '테스트',
  phone: '010-0000-0001',
  consentCollection: true,
  privacyVersion: 'privacy-test-v1',
  idempotencyKey: 'test-only-route-idem-0001',
  turnstileToken: 'test-only-turnstile-token',
};

async function call(payload: unknown) {
  const res = await POST(
    new Request('http://localhost/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify(payload),
    }),
  );
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: (await res.json()) as unknown };
}

const RESERVED = ['internet_phone', 'cctv_security', 'internet_only', 'other', 'mobile'] as const;
const VARIANTS: [string, unknown][] = [
  ['대문자', 'CCTV_SECURITY'],
  ['앞 공백', ' internet_tv'],
  ['하이픈', 'internet-tv'],
  ['배열', ['internet_tv']],
  ['객체', { key: 'internet_tv' }],
  ['숫자', 1],
  ['null', null],
  ['__proto__', '__proto__'],
  ['toString', 'toString'],
  ['동판(미정의)', 'dongpan'],
];
const NOT_ACTIVE = { ok: false, code: 'PRODUCT_NOT_ACTIVE' };

test('R1 예약 상품 5종: HTTP 403 + {ok:false, code:"PRODUCT_NOT_ACTIVE"}, 외부 확인·DB 접근 없음', async () => {
  setGate(true);
  for (const interest of RESERVED) {
    fetchCalls = 0;
    const r = await call({ ...base, interest });
    assert.equal(r.status, 403, interest);
    assert.match(r.type, /application\/json/, interest);
    assert.deepEqual(r.body, NOT_ACTIVE, interest);
    assert.equal(fetchCalls, 0, `${interest}: Turnstile 등 외부 요청 0회여야 함`);
  }
});

test('R2 변형·미정의 상품 값과 상품 누락도 403 PRODUCT_NOT_ACTIVE', async () => {
  setGate(true);
  for (const [label, interest] of VARIANTS) {
    fetchCalls = 0;
    const r = await call({ ...base, interest });
    assert.equal(r.status, 403, label);
    assert.deepEqual(r.body, NOT_ACTIVE, label);
    assert.equal(fetchCalls, 0, label);
  }
  fetchCalls = 0;
  const r = await call(base); // base에는 interest가 없다
  assert.equal(r.status, 403, '상품 누락');
  assert.deepEqual(r.body, NOT_ACTIVE, '상품 누락');
  assert.equal(fetchCalls, 0, '상품 누락');
});

test('R3 대조군: 활성 상품(인터넷+TV)은 상품 검사를 통과해 다음 단계(봇 확인)에서 멈춘다', async () => {
  setGate(true);
  fetchCalls = 0;
  const r = await call({ ...base, interest: 'internet_tv' });
  // 가짜 Turnstile 응답(success:false) → 403 BOT_SUSPECTED. 상품 검사가 활성 상품을 막지 않는다는 뜻이고, 저장은 일어나지 않는다
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { ok: false, code: 'BOT_SUSPECTED' });
  assert.equal(fetchCalls, 1, '활성 상품만 외부 확인 단계에 도달');
});

test('R4 수집이 꺼지면(E2E·운영 기본값) 상품과 관계없이 503 LEAD_INTAKE_DISABLED가 먼저 나온다', async () => {
  setGate(false);
  for (const interest of ['internet_tv', ...RESERVED]) {
    fetchCalls = 0;
    const r = await call({ ...base, interest });
    assert.equal(r.status, 503, interest);
    assert.deepEqual(r.body, { ok: false, code: 'LEAD_INTAKE_DISABLED' }, interest);
    assert.equal(fetchCalls, 0, interest);
  }
});

test('R5 Vercel 배포 환경에서는 로컬 모드 설정이 있어도 수집이 열리지 않는다', async () => {
  setGate(true);
  for (const v of ['production', 'preview']) {
    process.env.VERCEL_ENV = v;
    const r = await call({ ...base, interest: 'cctv_security' });
    assert.equal(r.status, 503, v);
    assert.deepEqual(r.body, { ok: false, code: 'LOCAL_MODE_NOT_ALLOWED_ON_VERCEL' }, v);
  }
  delete process.env.VERCEL_ENV;
});

// ---- PM 6907697718 B-3: 비활성 경로 사전 보완(JSON 루트·봇 확인 예외) ----

async function callRaw(raw: string) {
  const res = await POST(
    new Request('http://localhost/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: raw,
    }),
  );
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', text, body: JSON.parse(text) as unknown };
}

test('R6 JSON 루트가 객체가 아니면(null·배열·문자열·숫자·true) 예외 없이 400 INVALID_JSON, 외부 호출 0', async () => {
  setGate(true);
  for (const raw of ['null', '[]', '[{"interest":"internet_tv"}]', '"internet_tv"', '1', 'true']) {
    fetchCalls = 0;
    const r = await callRaw(raw);
    assert.equal(r.status, 400, raw);
    assert.match(r.type, /application\/json/, raw);
    assert.deepEqual(r.body, { ok: false, code: 'INVALID_JSON' }, raw);
    assert.equal(fetchCalls, 0, raw);
  }
});

test('R7 봇 확인 네트워크 실패·시간 초과·HTTP 오류·비JSON·형태 오류 → 503 BOT_CHECK_UNAVAILABLE(저장 단계로 가지 않음)', async () => {
  setGate(true);
  process.env.PUBLIC_HOSTNAME = 'example.test';
  const cases: [string, () => Response | Promise<Response>][] = [
    ['네트워크 실패', () => Promise.reject(new TypeError('fetch failed'))],
    ['시간 초과', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['HTTP 500', () => new Response('<html>oops</html>', { status: 500, headers: { 'content-type': 'text/html' } })],
    ['비JSON 200', () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['JSON null', () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['JSON 배열', () => new Response('[true]', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['success 누락', () => new Response('{"action":"lead_form"}', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['success 문자열', () => new Response('{"success":"true"}', { status: 200, headers: { 'content-type': 'application/json' } })],
  ];
  try {
    for (const [label, reply] of cases) {
      botReply = reply;
      fetchCalls = 0;
      const r = await callRaw(JSON.stringify({ ...base, interest: 'internet_tv' }));
      assert.equal(r.status, 503, label);
      assert.deepEqual(r.body, { ok: false, code: 'BOT_CHECK_UNAVAILABLE' }, label);
      assert.equal(fetchCalls, 1, label);
      // 응답에 외부 응답 원문·토큰·오류 문구가 반사되지 않는다
      for (const leak of ['oops', 'not json', 'fetch failed', 'timed out', base.turnstileToken, '010']) {
        assert.ok(!r.text.includes(leak), `${label}: ${leak}`);
      }
    }
  } finally {
    botReply = botFail;
  }
});

test('R8 봇 확인 action·hostname 검사는 약해지지 않는다(불일치·기대 호스트 미설정 → 403 BOT_SUSPECTED)', async () => {
  setGate(true);
  const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const cases: [string, string | undefined, () => Response][] = [
    ['action 불일치', 'example.test', ok({ success: true, action: 'login', hostname: 'example.test' })],
    ['hostname 불일치', 'example.test', ok({ success: true, action: 'lead_form', hostname: 'evil.test' })],
    ['hostname 누락', 'example.test', ok({ success: true, action: 'lead_form' })],
    ['기대 호스트 미설정', undefined, ok({ success: true, action: 'lead_form' })],
    ['success false', 'example.test', ok({ success: false, action: 'lead_form', hostname: 'example.test' })],
  ];
  try {
    for (const [label, host, reply] of cases) {
      if (host === undefined) delete process.env.PUBLIC_HOSTNAME;
      else process.env.PUBLIC_HOSTNAME = host;
      botReply = reply;
      fetchCalls = 0;
      const r = await call({ ...base, interest: 'internet_tv' });
      assert.equal(r.status, 403, label);
      assert.deepEqual(r.body, { ok: false, code: 'BOT_SUSPECTED' }, label);
      assert.equal(fetchCalls, 1, label);
    }
    // 토큰이 문자열이 아니면 외부 확인 없이 거부
    for (const t of [null, 123, { a: 1 }, ['x']]) {
      fetchCalls = 0;
      const r = await call({ ...base, interest: 'internet_tv', turnstileToken: t });
      assert.equal(r.status, 403, JSON.stringify(t));
      assert.deepEqual(r.body, { ok: false, code: 'BOT_SUSPECTED' });
      assert.equal(fetchCalls, 0, JSON.stringify(t));
    }
  } finally {
    botReply = botFail;
  }
});

test('R9 예약 상품은 봇 확인 예외 상황에서도 외부 호출 0, 403 PRODUCT_NOT_ACTIVE', async () => {
  setGate(true);
  botReply = () => Promise.reject(new TypeError('fetch failed'));
  try {
    for (const interest of RESERVED) {
      fetchCalls = 0;
      const r = await call({ ...base, interest });
      assert.equal(r.status, 403, interest);
      assert.deepEqual(r.body, NOT_ACTIVE, interest);
      assert.equal(fetchCalls, 0, interest);
    }
  } finally {
    botReply = botFail;
  }
});
