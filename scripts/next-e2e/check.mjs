// 실제 Next 서버에 HTTP로 요청하고, 실제 PostgreSQL을 직접 조회해 결과를 확인한다. 응답 본문의 개인정보·비밀은 출력하지 않는다.
import postgres from 'postgres';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runBrowserFlow } from './browser-flow.mjs';

const BASE = process.env.E2E_BASE;
const sql = postgres(process.env.E2E_ADMIN_URL, { max: 1, onnotice: () => {} });
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${note ? ` | ${note}` : ''}`); };
const n = async (q) => Number((await sql.unsafe(q))[0].n);
const post = async (p, body, headers = {}) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 본문 없음 */ }
  return { status: r.status, j, cache: r.headers.get('cache-control') };
};
// 가상 인증·봇 확인 서버: Supabase JWKS(ES256 공개키)와 Turnstile 확인 응답만 흉내 낸다. 외부 호출 없음
const b64u = (b) => Buffer.from(b).toString('base64url');
const KID = 'e2e-key-1';
const mkKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const good = mkKey(), evil = mkKey();
const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig', key_ops: ['verify'] };
const FAKE = Number(process.env.E2E_FAKE_PORT);
const seen = { turnstile: 0, jwks: 0 };
const fake = http.createServer((req, res) => {
  if (req.url?.startsWith('/auth/v1/.well-known/jwks.json')) { seen.jwks++; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [jwk] })); }
  if (req.url === '/turnstile' && req.method === 'POST') {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      seen.turnstile++;
      const tok = new URLSearchParams(raw).get('response');
      res.setHeader('content-type', 'application/json');
      if (tok === 'down') { res.statusCode = 500; return res.end('{}'); }
      if (tok === 'wrong-host') return res.end(JSON.stringify({ success: true, action: 'lead_form', hostname: 'evil.test' }));
      res.end(JSON.stringify(tok === 'ok' ? { success: true, action: 'lead_form', hostname: 'fideon.test' } : { success: false }));
    }); return;
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r));
const jwt = (claims, key = good) => {
  const h = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KID }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64u(JSON.stringify({ iss: `http://localhost:${FAKE}/auth/v1`, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, ...claims }));
  return `${h}.${p}.${b64u(crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }))}`;
};
const cookieFor = (claims, key) => {
  const access = jwt(claims, key); const now = Math.floor(Date.now() / 1000);
  const session = { access_token: access, refresh_token: 'e2e-refresh', token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, user: { id: claims.sub, aud: 'authenticated', role: 'authenticated', email: 'staff@fideon.test' } };
  return `sb-localhost-auth-token=base64-${b64u(JSON.stringify(session))}`;
};
const U = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const S = (n) => `10000000-0000-4000-8000-00000000000${n}`;
const ownerC = cookieFor({ sub: U(1), session_id: S(1), aal: 'aal2' });
const reviewerC = cookieFor({ sub: U(5), session_id: S(5), aal: 'aal2' });
const adm = (p, cookie, init = {}) => fetch(BASE + p, { ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
const CAMP = 'next-e2e-camp';
// 새 세션(session 없음)은 서버 측 봇 확인 필요(PM 11/22 F1) — 로컬 가짜 확인 서버가 'ok' 토큰을 통과시킨다
const chat = (extra = {}, ip = '198.51.100.7') => post('/api/consult/chat', { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금이 궁금해요', campaign: CAMP, ...('session' in extra ? {} : { turnstileToken: 'ok' }), ...extra }, { 'x-forwarded-for': ip });
try {
  const ev = () => n(`select count(*)::int as n from core.consult_events where campaign_key = '${CAMP}'`);
  const e0 = await ev();
  const a = await chat();
  check('N1 상담 첫 요청: 200, 서버가 서명 세션 발급, 응답 no-store', a.status === 200 && a.j?.ok === true && /^[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/.test(a.j?.session ?? '') && /no-store/.test(a.cache ?? ''), `status=${a.status}`);
  check('N2 DB에 상담 시작 1건 기록(캠페인 연결)', (await ev()) === e0 + 1);
  const b = await chat({ session: a.j?.session });
  check('N3 같은 세션 재전송: 200, DB 건수 그대로(중복 집계 없음)', b.status === 200 && (await ev()) === e0 + 1 && b.j?.session === a.j?.session);
  const [id, exp, sig] = String(a.j?.session).split('.');
  for (const [name, tok] of [['변조 서명', `${id}.${exp}.${'0'.repeat(64)}`], ['브라우저가 만든 id', 'abcdefabcdefabcdef'], ['다른 id에 서명 재사용', `${'f'.repeat(32)}.${exp}.${sig}`], ['만료 시각 늘리기', `${id}.${Number(exp) + 99999}.${sig}`]]) {
    const r = await chat({ session: tok });
    check(`N4 ${name}: 400 INVALID_SESSION, DB 건수 그대로`, r.status === 400 && r.j?.code === 'INVALID_SESSION' && (await ev()) === e0 + 1, `status=${r.status}`);
  }
  check('N5 답변 형식: 승인 정책이 없으면 담당자 확인 안내(금액·사은품 없음), 키 이름 노출 없음', typeof b.j?.text === 'string' && !/CONSULT_AI|API_KEY/.test(JSON.stringify(b.j)) && !/\d{1,3}(,\d{3})*원/.test(b.j.text));
  const ledger = await n(`select count(*)::int as n from core.ai_usage_ledger`);
  check('N6 AI 월 한도 기본 0원: 무료 모의 모델 경로에서 AI 사용료 예약·사용 0건', ledger === 0 && (await n(`select monthly_limit_krw as n from core.ai_budget_config where singleton`)) === 0);
  // 새 세션 발급은 IP별 제한(5개/시간)
  const codes = []; for (let i = 0; i < 7; i++) codes.push((await chat({}, '198.51.100.99')).status);
  check('N7 같은 IP의 새 세션 발급 제한: 5개 뒤 429', codes.filter((c) => c === 200).length === 5 && codes.includes(429), codes.join(','));
  // 접수: Turnstile(가상 확인 서버)을 통과해도 실제 설정의 필수 고지가 미확정이면 접수는 막힌다(DB 0건)
  const l0 = await n(`select count(*)::int as n from core.leads`);
  const L = (tok) => post('/api/leads', { name: '홍길동', phone: '010-1234-5678', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['collection_purpose', 'not_a_contract', 'policy_confirm'], noticeHashes: { collection_purpose: 'a'.repeat(64), not_a_contract: 'a'.repeat(64), policy_confirm: 'a'.repeat(64) }, idempotencyKey: 'next-e2e-lead-000000001', turnstileToken: tok });
  const t0 = seen.turnstile;
  const bad = await L('nope'), host = await L('wrong-host'), down = await L('down');
  check('N8 봇 확인: 실패 403, 호스트 불일치 403, 확인 서버 장애 503(접수 안 함)', bad.status === 403 && host.status === 403 && down.status === 503, `${bad.status},${host.status},${down.status}`);
  const okTs = await L('ok');
  check('N8b 봇 확인 통과 + 필수 고지 미확정 → 접수 차단 유지(NOTICE_NOT_CONFIRMED 503), 확인 서버를 실제 경유', okTs.status === 503 && okTs.j?.code === 'NOTICE_NOT_CONFIRMED' && seen.turnstile === t0 + 4, `status=${okTs.status} code=${okTs.j?.code}`);
  check('N8c 위 모든 시도에서 DB 접수 0건 증가', (await n(`select count(*)::int as n from core.leads`)) === l0);
  // 관리자 로그인(가상 Supabase JWT, 서명 검증·MFA·DB 세션): 무인증·위조·MFA 없음·폐기 세션은 거부
  const au0 = await n(`select count(*)::int as n from core.audit_logs`);
  const noAuth = await adm('/api/admin/ai/budget');
  check('N9 무인증 관리자 API: 401', noAuth.status === 401, `status=${noAuth.status}`);
  const forged = await adm('/api/admin/ai/budget', cookieFor({ sub: U(1), session_id: S(1), aal: 'aal2' }, evil));
  check('N9b 다른 키로 서명한 JWT: 거부(401)', forged.status === 401, `status=${forged.status}`);
  const aal1 = await adm('/api/admin/ai/budget', cookieFor({ sub: U(1), session_id: S(1), aal: 'aal1' }));
  check('N9c MFA(aal2) 없는 로그인: 403', aal1.status === 403, `status=${aal1.status}`);
  const revoked = await adm('/api/admin/ai/budget', cookieFor({ sub: U(1), session_id: S(7), aal: 'aal2' }));
  check('N9d DB에서 폐기된 세션: 거부(401/403)', [401, 403].includes(revoked.status), `status=${revoked.status}`);
  const counselor = await adm('/api/admin/ai/budget', cookieFor({ sub: U(2), session_id: S(2), aal: 'aal2' }));
  check('N9e 상담원 역할은 AI 한도 조회 불가(403)', counselor.status === 403, `status=${counselor.status}`);
  check('N9f 위 거부 요청들이 DB를 바꾸지 않음', (await n(`select count(*)::int as n from core.audit_logs`)) === au0);
  const g = await adm('/api/admin/ai/budget', ownerC);
  const gj = await g.json().catch(() => ({}));
  check('N10 대표 로그인: AI 한도 조회 200, 기본 0원', g.status === 200 && gj.limitKrw === 0, `status=${g.status}`);
  const rv = await adm('/api/admin/ai/budget', reviewerC, { method: 'POST', body: JSON.stringify({ limitKrw: 100, reason: '검토자 시도' }) });
  check('N10b 검토자는 한도 설정 불가(403), 한도 0원 유지', rv.status === 403 && (await n(`select monthly_limit_krw as n from core.ai_budget_config where singleton`)) === 0, `status=${rv.status}`);
  const set = await adm('/api/admin/ai/budget', ownerC, { method: 'POST', body: JSON.stringify({ limitKrw: 100, reason: 'Next E2E 시험' }) });
  check('N11 대표가 한도 설정 200 → DB 반영 + 감사 기록 1건, 바로 0원으로 복구', set.status === 200 && (await n(`select monthly_limit_krw as n from core.ai_budget_config where singleton`)) === 100 && (await n(`select count(*)::int as n from core.audit_logs where action = 'ai.budget_limit_set'`)) === 1, `status=${set.status}`);
  await adm('/api/admin/ai/budget', ownerC, { method: 'POST', body: JSON.stringify({ limitKrw: 0, reason: 'Next E2E 복구' }) });
  check('N11b 복구 후 한도 0원', (await n(`select monthly_limit_krw as n from core.ai_budget_config where singleton`)) === 0);
  // 접수(실제 접수 코드, 시험 고지) → 암호화 저장 → Next 관리자 목록에 마스킹되어 보임
  const sd = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/next-e2e/seed-lead.mts'], { env: process.env, encoding: 'utf8', timeout: 60000 });
  check('N12 접수 코드 실행(시험 고지): 성공, DB 저장', sd.status === 0 && (await n(`select count(*)::int as n from core.leads`)) === l0 + 1, (sd.stdout + sd.stderr).slice(0, 120).replace(/\n/g, ' '));
  const enc = await sql.unsafe(`select count(*)::int as n from core.leads where idempotency_key = 'next-e2e-seed-0000000001' and name_masked is not null`);
  check('N12b 개인정보는 암호화 저장(원문 이름·전화가 평문 열에 없음)', Number(enc[0].n) === 1 && (await n(`select count(*)::int as n from core.leads l where to_jsonb(l)::text like '%7777%' or to_jsonb(l)::text like '%김이투이%'`)) === 0);
  const ll = await adm('/api/admin/leads?limit=1', ownerC);
  const lt = await ll.text();
  check('N13 관리자 접수 목록(Next→DB): 200, 마스킹된 전화번호 표시, 원문 전화·이름 없음', ll.status === 200 && lt.includes('010-****-1234') && !lt.includes('7777') && !lt.includes('김이투이'), `status=${ll.status} ${ll.status === 200 ? '' : lt.slice(0, 120)}`);
  check('N13b 무인증·검토자 외 역할 규칙: 무인증 목록 401', (await adm('/api/admin/leads')).status === 401);
  // /admin/* 전체 화면: 로그인·MFA·역할 제한과 우회 시도. 허용된 역할만 화면 표지가 보이고, 나머지는 표지·데이터가 응답에 없다
  await sql.unsafe(`insert into core.staff (user_id, role, active) values ('${U(6)}', 'policy_editor', true) on conflict do nothing`);
  await sql.unsafe(`insert into security.staff_sessions (id, user_id, created_at, revoked_at) values ('${S(8)}', '${U(6)}', now(), null) on conflict do nothing`);
  const editorC = cookieFor({ sub: U(6), session_id: S(8), aal: 'aal2' });
  const counselorC = cookieFor({ sub: U(2), session_id: S(2), aal: 'aal2' });
  const aal1C = cookieFor({ sub: U(1), session_id: S(1), aal: 'aal1' });
  const forgedC = cookieFor({ sub: U(1), session_id: S(1), aal: 'aal2' }, evil);
  const revokedC = cookieFor({ sub: U(1), session_id: S(7), aal: 'aal2' });
  const PAGES = [
    ['/admin/progress', 'FIDEON 진행 상황', new Set(['owner'])],
    ['/admin/policies', 'FIDEON 관리 · 정책', new Set(['owner', 'editor', 'reviewer'])],
    ['/admin/ads', 'FIDEON 관리 · 광고 예산', new Set(['owner', 'reviewer'])],
    ['/admin/ads/funnel', 'FIDEON 관리 · 광고 성과', new Set(['owner', 'reviewer'])],
    ['/admin/ai-budget', 'FIDEON 관리 · AI 월 비용 한도', new Set(['owner', 'reviewer'])],
    ['/admin/notices', 'FIDEON 관리 · 필수 고지', new Set(['owner', 'reviewer'])],
  ];
  const get = (p, cookie, headers = {}) => fetch(BASE + p, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const who = { owner: ownerC, reviewer: reviewerC, editor: editorC, counselor: counselorC };
  let pageFail = [];
  for (const [path, mark, allowed] of PAGES) {
    for (const [role, c] of Object.entries(who)) {
      const r = await get(path, c); const t = await r.text();
      const shown = r.status === 200 && t.includes(mark);
      if (shown !== allowed.has(role)) pageFail.push(`${path}:${role}:${r.status}:${shown}`);
    }
  }
  check('P1 역할별 화면 접근: 허용 역할만 표지가 보이고 나머지(상담원 포함)는 보이지 않음', pageFail.length === 0, pageFail.slice(0, 4).join(' '));
  let bypass = [];
  const attempts = [
    ['무인증', null, {}], ['MFA 없음(aal1)', aal1C, {}], ['위조 서명', forgedC, {}], ['폐기 세션', revokedC, {}],
    ['RSC 요청', null, { RSC: '1' }], ['미들웨어 우회 헤더', null, { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' }],
    ['역할 헤더 주입', null, { 'x-role': 'owner', 'x-staff-role': 'owner', 'x-user-id': U(1) }], ['쿠키 없이 Authorization', null, { authorization: `Bearer ${jwt({ sub: U(1), session_id: S(1), aal: 'aal2' })}` }],
  ];
  for (const [path, mark] of PAGES) {
    for (const [name, c, h] of attempts) {
      for (const variant of [path, path + '/', path + '?role=owner&actor=' + U(1), path.replace('/admin', '/admin/.')]) {
        const r = await get(variant, c, h); const t = await r.text();
        if (r.status === 200 && t.includes(mark)) bypass.push(`${name}:${variant}`);
      }
    }
  }
  check('P2 우회 시도(무인증·aal1·위조·폐기 세션·RSC·미들웨어 우회 헤더·역할 헤더·Authorization·경로 변형)는 모든 관리자 화면에서 표지·데이터 0', bypass.length === 0, bypass.slice(0, 4).join(' '));
  const un = await get('/admin/ai-budget');
  check('P3 무인증 화면은 로그인으로 이동', [302, 303, 307, 308].includes(un.status) && (un.headers.get('location') ?? '').includes('/admin/login'), `status=${un.status} loc=${un.headers.get('location')}`);
  const lead0 = await get('/admin'); const lt0 = await lead0.text();
  check('P4 무인증 /admin(접수 목록): 로그인으로 이동, 접수 데이터 없음', [302, 303, 307, 308].includes(lead0.status) && !lt0.includes('010-'), `status=${lead0.status}`);
  const lead1 = await get('/admin', ownerC);
  check('P5 로그인한 직원은 /admin 화면이 열림(이동 없음)', lead1.status === 200, `status=${lead1.status}`);
  const login = await get('/admin/login');
  check('P6 /admin/login은 무인증으로 열림, 관리자 화면 응답은 no-store·검색 제외', login.status === 200 && /no-store/.test(login.headers.get('cache-control') ?? '') && /noindex/.test(login.headers.get('x-robots-tag') ?? ''), `status=${login.status}`);
  // /api/admin/* 전 라우트(파일 목록에서 자동 생성): 무인증 GET·POST는 어떤 것도 200이 아님
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((n) => { const f = `${d}/${n}`; return statSync(f).isDirectory() ? walk(f) : [f]; });
  const apiPaths = walk('src/app/api/admin').filter((f) => f.endsWith('/route.ts')).map((f) => '/' + f.slice('src/app/'.length, -'/route.ts'.length).replace('[id]', '10000000-0000-4000-8000-000000000001'));
  let apiBad = [];
  for (const ap of apiPaths) for (const [name, c] of [['무인증', null], ['aal1', aal1C], ['위조', forgedC], ['폐기', revokedC]]) for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const r = await fetch(BASE + ap, { method, headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) }, body: method === 'GET' ? undefined : '{}' });
    if (r.status === 200 || r.status >= 500 && r.status !== 503) apiBad.push(`${name}:${method}:${ap}:${r.status}`);
  }
  check(`P7 /api/admin 전 라우트 ${apiPaths.length}개 × 무인증·aal1·위조·폐기 × 4개 메서드: 200·서버 오류 없음`, apiBad.length === 0 && apiPaths.length >= 8, apiBad.slice(0, 4).join(' '));
  // 정책 관리자 API(ADMIN_POLICY_SOURCE=db): 초안 → 제출 → 승인, 역할·상태 규칙·감사, 실제 Next 라우트 경유
  const kn = (value) => ({ known: true, value });
  const krw = (v) => kn({ amountKrw: v, vat: 'included' });
  const t = Date.now();
  const upload = { supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'next-e2e-p1', category: 'internet_tv', sourceKind: 'official_policy_sheet',
    confirmedAt: new Date(t - 3600_000).toISOString(), validFrom: new Date(t - 3600_000).toISOString(), validUntil: new Date(t + 86_400_000).toISOString(), productLabel: '가상 인터넷+TV(Next E2E)',
    terms: { monthlyFee: krw(11111), contractMonths: kn(36), equipmentMonthlyFee: krw(0), installFee: krw(2222), bundlePrerequisites: kn([]), regionScope: kn('nationwide'),
      customerBenefit: kn({ amountKrw: 3333, form: 'gift_card', payoutCondition: kn('x'), cancellationCondition: kn('y') }) } };
  const pj = async (r) => { try { return await r.json(); } catch { return {}; } };
  const pol = (c, body, p = '/api/admin/policies') => adm(p, c, { method: 'POST', body: JSON.stringify(body) });
  const dry = await pol(editorC, { ...upload, dryRun: true });
  check('Q1 정책 초안 사전 검사(dryRun): 편집자 200, 견적 가능 판정', dry.status === 200 && (await pj(dry)).quotable === true, `status=${dry.status}`);
  const denied = [['검토자', reviewerC], ['상담원', counselorC], ['무인증', null]];
  const dn = []; for (const [nm, c] of denied) { const r = await pol(c, upload); if (![401, 403].includes(r.status)) dn.push(`${nm}:${r.status}`); }
  const pc0 = await n(`select count(*)::int as n from core.policy_versions where product_id = 'next-e2e-p1'`);
  check('Q2 초안 생성은 편집자·대표만: 검토자·상담원·무인증 거부, DB 0건', dn.length === 0 && pc0 === 0, dn.join(' '));
  const cr = await pol(editorC, upload); const cj = await pj(cr);
  check('Q3 편집자 초안 생성 201, DB에 draft로 저장(terms는 객체)', cr.status === 201 && /^[0-9a-f-]{36}$/.test(cj.id ?? '') && (await sql.unsafe(`select jsonb_typeof(terms) as t, state from core.policy_versions where id = '${cj.id}'`))[0]?.state === 'draft', `status=${cr.status}`);
  const pid = cj.id; const act = (c, body) => pol(c, body, `/api/admin/policies/${pid}`);
  const CHK = { source_matched: true, validity: true, vat: true, benefit_terms: true, region_bundle: true };
  const stateNow = async () => (await sql.unsafe(`select state from core.policy_versions where id = '${pid}'`))[0]?.state;
  const early = await act(ownerC, { action: 'approve', reason: '제출 전 승인 시도', checks: CHK });
  check('Q4 제출 전(draft) 승인은 불가(403/422), 상태 그대로', [403, 422].includes(early.status) && (await stateNow()) === 'draft', `status=${early.status}`);
  check('Q5 편집자 제출 200 → submitted', (await act(editorC, { action: 'submit' })).status === 200 && (await stateNow()) === 'submitted');
  const noAp = []; for (const [nm, c] of [['편집자', editorC], ['검토자', reviewerC], ['상담원', counselorC], ['무인증', null]]) { const r = await act(c, { action: 'approve', reason: '권한 없는 승인', checks: CHK }); if (![401, 403].includes(r.status)) noAp.push(`${nm}:${r.status}`); }
  check('Q6 승인은 대표만: 편집자(자기 제출 포함)·검토자·상담원·무인증 거부, 상태 submitted 유지', noAp.length === 0 && (await stateNow()) === 'submitted', noAp.join(' '));
  const noChk = await act(ownerC, { action: 'approve', reason: '검사 누락', checks: { ...CHK, vat: false } });
  check('Q7 확인 항목 하나라도 빠지면 승인 불가(422)', noChk.status === 422 && (await stateNow()) === 'submitted', `status=${noChk.status}`);
  const a0 = await n(`select count(*)::int as n from core.audit_logs where action like 'policy.%'`);
  const ok = await act(ownerC, { action: 'approve', reason: 'Next E2E 승인', checks: CHK });
  check('Q8 대표 승인 200 → approved, 감사 기록 증가', ok.status === 200 && (await stateNow()) === 'approved' && (await n(`select count(*)::int as n from core.audit_logs where action like 'policy.%'`)) > a0, `status=${ok.status}`);
  const lst = await adm('/api/admin/policies?limit=100', ownerC); const lj = await pj(lst);
  check('Q9 대표 정책 목록(Next→DB)에 승인본이 보이고 내부 금액 필드(수수료)는 없음', lst.status === 200 && lj.items?.some((i) => i.id === pid && i.state === 'approved') && !JSON.stringify(lj).includes('commission'), `status=${lst.status}`);
  check('Q10 상담원·무인증 목록 거부', [401, 403].includes((await adm('/api/admin/policies', counselorC)).status) && (await adm('/api/admin/policies')).status === 401);
  // 정책 승인 → 게시 스위치(DB policy_publish, 검수용 환경에서만) → AI 상담 반영. 게시 OFF면 승인돼도 금액 안내 없음
  const ask = async (productId, ip) => { const r = await chat({ productId }, ip); return { status: r.status, text: String(r.j?.text ?? '') }; };
  const flag = async () => (await sql.unsafe(`select enabled from core.feature_flags where key = 'policy_publish'`))[0]?.enabled;
  check('Q11 정책 게시 스위치 기본 OFF(DB 초기값)', (await flag()) === false);
  const off1 = await ask('next-e2e-p1', '198.51.100.21');
  check('Q12 승인됐어도 게시 OFF면 상담은 금액·사은품을 말하지 않음(담당자 확인 안내)', off1.status === 200 && !/11,111|3,333/.test(off1.text), `status=${off1.status}`);
  // 초안(미승인) 정책은 게시를 켜도 보이지 않는다
  const upload2 = { ...upload, productId: 'next-e2e-p2', productLabel: '가상 미승인 상품' };
  const cr2 = await pol(editorC, upload2);
  await sql.unsafe(`update core.feature_flags set enabled = true where key = 'policy_publish'`);
  try {
    const on1 = await ask('next-e2e-p1', '198.51.100.22');
    check('Q13 게시 ON: 승인된 정책의 월 요금·사은품이 AI 상담 답변에 반영, 수수료·내부 필드 없음', on1.status === 200 && on1.text.includes('11,111') && on1.text.includes('3,333') && !/commission|수수료/.test(on1.text), `status=${on1.status}`);
    const on2 = await ask('next-e2e-p2', '198.51.100.23');
    check('Q14 게시 ON이어도 미승인(draft) 정책은 상담에 반영되지 않음', cr2.status === 201 && on2.status === 200 && !/11,111|3,333/.test(on2.text), `draft=${cr2.status}`);
    const none = await ask('next-e2e-none', '198.51.100.24');
    check('Q14b 정책 없는 상품은 금액을 만들어 내지 않음', none.status === 200 && !/\d{1,3}(,\d{3})+원/.test(none.text));
  } finally { await sql.unsafe(`update core.feature_flags set enabled = false where key = 'policy_publish'`); }
  const off2 = await ask('next-e2e-p1', '198.51.100.25');
  check('Q15 게시를 다시 끄면 즉시 금액 안내 중단, 스위치 OFF 복구', !/11,111|3,333/.test(off2.text) && (await flag()) === false);
  check('Q16 이 흐름에서도 AI 사용료 0건(무료 모의 모델)', (await n(`select count(*)::int as n from core.ai_usage_ledger`)) === 0);
  // 필수 고지: 화면 상수 ↔ DB 문구 대조(읽기 전용), 불일치 사유 코드 감지
  const nw = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/next-e2e/notice-wiring.mts'], { env: process.env, encoding: 'utf8', timeout: 60000 });
  let nj = null; try { nj = JSON.parse(nw.stdout.trim().split('\n').pop()); } catch { /* 아래에서 실패 처리 */ }
  check('N15 필수 고지 문구·버전 대조: 같으면 일치, 문구 수정·키 누락·버전 없음은 사유 코드로 감지', nj && nj.n === 3 && nj.same.length === 0 && nj.edited.join() === 'BODY_MISMATCH:collection_purpose' && nj.dropped.join() === 'KEY_EXTRA_IN_DB:collection_purpose' && nj.other.join() === 'NO_DB_TEXTS', (nw.stdout + nw.stderr).slice(0, 160).replace(/\n/g, ' '));
  // 게시 ON/OFF API(대표 전용): 즉시 상담 반영, 권한·사유·감사 기록
  const pubUrl = '/api/admin/policies/publish';
  const pub = (c, body) => adm(pubUrl, c, { method: 'POST', body: JSON.stringify(body) });
  const pcnt = (a) => n(`select count(*)::int as n from core.audit_logs where action = '${a}'`);
  const pg0 = await adm(pubUrl, ownerC); const pgj = await pj(pg0);
  check('PB1 대표 게시 상태 조회 200, 현재 OFF', pg0.status === 200 && pgj.enabled === false && pgj.role === 'owner', `status=${pg0.status}`);
  const pd = []; for (const [nm, c] of [['편집자', editorC], ['검토자', reviewerC], ['상담원', counselorC], ['무인증', null]]) { const r = await pub(c, { enabled: true, reason: '권한 없는 게시 시도' }); if (![401, 403].includes(r.status)) pd.push(`${nm}:${r.status}`); }
  check('PB2 게시 변경은 대표만: 편집자·검토자·상담원·무인증 거부, 스위치 OFF 유지', pd.length === 0 && (await flag()) === false, pd.join(' '));
  const nr = await pub(ownerC, { enabled: true, reason: '' });
  check('PB3 사유 없으면 422, 스위치 변화 없음', nr.status === 422 && (await flag()) === false, `status=${nr.status}`);
  const on0 = await pcnt('policy.publish_on'), off0 = await pcnt('policy.publish_off');
  try {
    const onR = await pub(ownerC, { enabled: true, reason: 'Next E2E 게시 켜기' });
    const a1 = await ask('next-e2e-p1', '198.51.100.31');
    check('PB4 대표 게시 ON(API) → 즉시 AI 상담에 금액·사은품 반영, 감사 기록 1건', onR.status === 200 && (await flag()) === true && a1.text.includes('11,111') && a1.text.includes('3,333') && (await pcnt('policy.publish_on')) === on0 + 1, `status=${onR.status}`);
    const offR = await pub(ownerC, { enabled: false, reason: 'Next E2E 게시 끄기' });
    const a2 = await ask('next-e2e-p1', '198.51.100.32');
    check('PB5 대표 게시 OFF(API) → 즉시 금액 안내 중단, 감사 기록 1건', offR.status === 200 && (await flag()) === false && !/11,111|3,333/.test(a2.text) && (await pcnt('policy.publish_off')) === off0 + 1, `status=${offR.status}`);
  } finally { await sql.unsafe(`update core.feature_flags set enabled = false where key = 'policy_publish'`); }
  const bk = await pub(ownerC, { enabled: 'yes', reason: '잘못된 값' });
  check('PB6 enabled가 불리언이 아니면 422', bk.status === 422 && (await flag()) === false, `status=${bk.status}`);
  // 필수 고지 입력·버전 관리(대표 입력, 검토자 조회). 입력해도 접수 차단은 코드 상수가 풀리기 전까지 유지
  const nurl = '/api/admin/notices';
  const nad = (c, body) => adm(nurl, c, { method: 'POST', body: JSON.stringify(body) });
  const NB = { version: 'next-e2e-v1', key: 'collection_purpose', body: '[검수용 시험 문구 — 실제 고지 아님]', reason: 'Next E2E 시험 입력' };
  const nc0 = await n(`select count(*)::int as n from core.notice_texts`);
  const nd = []; for (const [nm, c] of [['편집자', editorC], ['검토자', reviewerC], ['상담원', counselorC], ['무인증', null]]) { const r = await nad(c, NB); if (![401, 403].includes(r.status)) nd.push(`${nm}:${r.status}`); }
  check('NA1 고지 문구 입력은 대표만: 그 외 거부, DB 변화 없음', nd.length === 0 && (await n(`select count(*)::int as n from core.notice_texts`)) === nc0, nd.join(' '));
  const na = await nad(ownerC, NB); const naj = await pj(na);
  check('NA2 대표 입력 201, sha256 반환·DB 저장, 감사 기록에 본문 없음', na.status === 201 && /^[0-9a-f]{64}$/.test(naj.sha256 ?? '') && (await n(`select count(*)::int as n from core.audit_logs where action = 'notice.text_add' and detail::text like '%시험 문구%'`)) === 0 && (await n(`select count(*)::int as n from core.audit_logs where action = 'notice.text_add'`)) >= 1, `status=${na.status}`);
  const dup = await nad(ownerC, NB);
  check('NA3 같은 버전·항목 재입력은 422(덮어쓰기 불가)', dup.status === 422 && (await n(`select count(*)::int as n from core.notice_texts where version = 'next-e2e-v1'`)) === 1, `status=${dup.status}`);
  const nl = await adm(nurl, reviewerC); const nlj = await pj(nl);
  check('NA4 검토자 목록 조회 200, 상담원·편집자·무인증 거부', nl.status === 200 && JSON.stringify(nlj).includes('next-e2e-v1') && [401, 403].includes((await adm(nurl, counselorC)).status) && [401, 403].includes((await adm(nurl, editorC)).status) && (await adm(nurl)).status === 401);
  const ex = await nad(ownerC, { ...NB, key: 'x', extra: 1 });
  check('NA5 알 수 없는 필드 거부(422)', ex.status === 422, `status=${ex.status}`);
  const lc0 = await n(`select count(*)::int as n from core.leads`);
  const blk = await post('/api/leads', { name: '홍길동', phone: '010-1234-5678', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'next-e2e-v1', noticeKeys: ['collection_purpose'], noticeHashes: { collection_purpose: 'a'.repeat(64) }, idempotencyKey: 'next-e2e-lead-000000002', turnstileToken: 'ok' });
  check('NA6 고지 문구를 DB에 입력해도 접수 차단 유지(NOTICE_NOT_CONFIRMED 503), 접수 0건 증가', blk.status === 503 && blk.j?.code === 'NOTICE_NOT_CONFIRMED' && (await n(`select count(*)::int as n from core.leads`)) === lc0, `status=${blk.status} code=${blk.j?.code}`);
  // 총판 원문 ↔ 실제 DB 저장 문구 대조(읽기 전용)
  const ns = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/next-e2e/notice-source.mts'], { env: process.env, encoding: 'utf8', timeout: 60000 });
  let sj = null; try { sj = JSON.parse(ns.stdout.trim().split('\n').pop()); } catch { /* 아래에서 실패 처리 */ }
  check('NA7 총판 원문 대조(실제 DB 문구): 같으면 일치, 공백만 다르면 구분, 내용 다르면 차이, 없는 항목 감지', sj && sj.saved && sj.same.join() === 'collection_purpose:MATCH' && sj.crlf.join() === 'collection_purpose:MATCH' && sj.ws.join() === 'collection_purpose:WHITESPACE_ONLY' && sj.diff.join() === 'collection_purpose:DIFF' && sj.missing.join() === 'other_key:KEY_MISSING_IN_DB,collection_purpose:SOURCE_MISSING', (ns.stdout + ns.stderr).slice(0, 160).replace(/\n/g, ' '));
  // 총판 고지 조건 검수(대표·검토자): 확인 5개 + 자기 입력 승인 금지 + 추가 전용, 그리고 "승인 이후" 전체 접수 흐름
  const rurl = '/api/admin/notices/review';
  const rev = (c, body) => adm(rurl, c, { method: 'POST', body: JSON.stringify(body) });
  const RC = { source_matched: true, version_matched: true, keys_complete: true, conditions_checked: true, screen_checked: true };
  const RB = { version: 'next-e2e-v1', decision: 'approved', checks: RC, reason: 'Next E2E 검수' };
  const rc = (w = '') => n(`select count(*)::int as n from core.notice_reviews where version = 'next-e2e-v1' ${w ? 'and ' + w.replace(/^where /, '') : ''}`);
  const rd = []; for (const [nm, c] of [['편집자', editorC], ['상담원', counselorC], ['무인증', null]]) { const r = await rev(c, RB); if (![401, 403].includes(r.status)) rd.push(`${nm}:${r.status}`); }
  check('RV1 검수 기록은 대표·검토자만: 편집자·상담원·무인증 거부, DB 0건', rd.length === 0 && (await rc()) === 0, rd.join(' '));
  const inc = await rev(reviewerC, { ...RB, checks: { ...RC, conditions_checked: false } }); const incj = await pj(inc);
  check('RV2 적용 조건 확인이 빠지면 승인 불가(422 CHECKS_INCOMPLETE)', inc.status === 422 && incj.code === 'CHECKS_INCOMPLETE' && (await rc()) === 0, `status=${inc.status} ${incj.code}`);
  // 접수 문서 버전은 DB 설정(privacy_policy_version)과 같아야 한다 — 고지 버전을 바꾸는 배포에서는 이 설정도 함께 바뀌어야 한다(시험 뒤 원래 값으로 복구)
  const pv = async (v) => sql.unsafe(`update core.settings set value = '${JSON.stringify(v)}'::jsonb where key = 'privacy_policy_version'`);
  const pv0 = (await sql.unsafe(`select value #>> '{}' as v from core.settings where key = 'privacy_policy_version'`))[0]?.v;
  const runFlow = async (env = {}, { version = true } = {}) => {
    try {
      if (version) await pv('next-e2e-v1');
      const r = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/next-e2e/flow-approved.mts'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
      let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 아래에서 실패 처리 */ }
      return { status: r.status, j, raw: (r.stdout + r.stderr).slice(0, 140).replace(/\n/g, ' ') };
    } finally { await pv(pv0); }
  };
  const lc = () => n(`select count(*)::int as n from core.leads`);
  const lf0 = await lc();
  const f0 = await runFlow();
  check('RV3 검수 승인 전에는 서버 접수 게이트가 막음(NOTICE_NOT_APPROVED 503), 접수 0건', f0.j?.code === 'NOTICE_NOT_APPROVED' && f0.j?.status === 503 && (await lc()) === lf0, f0.raw);
  const self = await rev(ownerC, RB);
  check('RV4 문구를 입력한 대표는 같은 버전을 승인할 수 없음(403), 승인 기록 0건', self.status === 403 && (await rc(`where decision = 'approved'`)) === 0, `status=${self.status}`);
  const rej = await rev(ownerC, { ...RB, decision: 'rejected', checks: { ...RC, screen_checked: false }, reason: '화면 확인 전 반려' });
  check('RV5 대표도 반려는 기록 가능(201), 반려는 승인으로 취급되지 않음', rej.status === 201 && (await rc(`where decision = 'rejected'`)) === 1 && (await rc(`where decision = 'approved'`)) === 0, `status=${rej.status}`);
  const ra0 = await n(`select count(*)::int as n from core.audit_logs where action = 'notice.review_approved'`);
  const okr = await rev(reviewerC, RB);
  check('RV6 검토자 승인 201, 승인 감사 기록 1건 증가', okr.status === 201 && (await rc(`where decision = 'approved'`)) === 1 && (await n(`select count(*)::int as n from core.audit_logs where action = 'notice.review_approved'`)) === ra0 + 1, `status=${okr.status}`);
  const rl = await adm(rurl, reviewerC); const rlj = await pj(rl);
  check('RV7 검수 이력 조회: 승인(현재 문구 기준) 표시, 정책 담당·무인증은 조회 불가', rl.status === 200 && rlj.items?.some((i) => i.version === 'next-e2e-v1' && i.decision === 'approved' && i.is_current === true) && [401, 403].includes((await adm(rurl, editorC)).status) && (await adm(rurl)).status === 401);
  // 승인 이후 전체 흐름: DB 승인 문구로 구성한 화면 설정 → 동의·고지 키 → 서버 게이트(버전·해시·승인) → 접수(암호화) → 노출 기록 해시 → 관리자 목록(마스킹)
  const flow = await runFlow({ FLOW_APP: '1' });
  check('FL1 승인된 고지 설정으로 접수: 서버 게이트 통과, DB에 1건 저장', flow.status === 0 && (await lc()) === lf0 + 1, flow.raw);
  check('FL2 고객별 고지 노출 기록의 해시가 승인된 DB 문구 해시와 같음, 동의 기록 있음', (await n(`select count(*)::int as n from pii.notice_exposures e join core.notice_texts t on t.version = e.doc_version and t.notice_key = e.notice_key and t.body_sha256 = e.body_sha256 where e.doc_version = 'next-e2e-v1'`)) === 1 && (await n(`select count(*)::int as n from pii.consents where doc_version = 'next-e2e-v1' and granted`)) === 1);
  check('FL3 개인정보 암호화 저장(평문 이름·전화 없음)', (await n(`select count(*)::int as n from pii.customers c where to_jsonb(c)::text like '%8888%' or to_jsonb(c)::text like '%김플로우%'`)) === 0 && (await n(`select count(*)::int as n from core.leads l where to_jsonb(l)::text like '%8888%' or to_jsonb(l)::text like '%김플로우%'`)) === 0);
  // 총판 전달용 신청서(PM 11/22): 접수와 같은 트랜잭션에서 암호화 저장 → 대표 열람(사유·복호화) → 복사·전달 이력 → 권한·감사
  const lid = (await sql.unsafe(`select lead_id::text as id from pii.lead_applications order by created_at limit 1`))[0]?.id;
  check('AP1 신청서가 접수와 함께 저장되고(1건) DB에는 평문 주소가 없음(암호문·범주형 요약만)', (await n(`select count(*)::int as n from pii.lead_applications where lead_id = '${lid}'`)) === 1 && (await n(`select count(*)::int as n from pii.lead_applications a where to_jsonb(a)::text like '%시험로%'`)) === 0 && (await n(`select count(*)::int as n from pii.lead_applications a where a.payload_enc ~ '^v[0-9]+:'`)) === 1, `lid=${lid}`);
  const pk = (c, body) => adm(`/api/admin/leads/${lid}/packet`, c, { method: 'POST', body: JSON.stringify(body) });
  const RS = { reason: 'dealer_handoff' };
  const pk0 = await pk(ownerC, {}); const pkf = await pk(ownerC, { reason: '김플로우 010-8888-4321 확인' }); const pk1 = await pk(ownerC, RS); const pkj = await pj(pk1); const pkt = pkj.packet?.text ?? '';
  const ORDER = ['고객명: 김플로우', '주민번호: 총판 별도 확인', '설치주소: 서울시 가상구 시험로 12 101동 1203호', '연락처 / 통신사: 01088884321 / SKT', '이메일: e2e.test@example.com', '자동이체: 총판 별도 확인', '사은품계좌: 총판 별도 확인', '가입 통신사: kt', '신청상품:', '월요금:', '설치비(기사출동비):', '설치희망일 / 빠른 날짜: 빠른 날짜', '상품권:', '이전통신사: SK브로드밴드', '기타: 기존회선 12개월 유지 안내: 고객 확인함', '기존회선 확인: 기존 회선 있음', '약정 3년 및 설치비 안내·확인: 고객 확인함'];
  let at = -1; const inOrder = ORDER.every((o) => { const k = pkt.indexOf(`■ ${o}`); const ok = k > at; at = k; return ok; });
  check('AP2 열람 사유는 고정 코드만(없음·자유 문장 400), 대표 열람 200·no-store, 총판 양식 17항목이 지정 순서로 출력, 주민번호·자동이체·사은품계좌는 총판 별도 확인', pk0.status === 400 && pkf.status === 400 && pk1.status === 200 && /no-store/.test(pk1.headers.get('cache-control') ?? '') && inOrder && /월요금: 총판 확인/.test(pkt) && !/주민번호: (?!총판 별도 확인)/.test(pkt), `status=${pk1.status} inOrder=${inOrder}`);
  check('AP2b 필수 고지 확정 전(실제 상수 미확정)에는 "총판 전달 준비 완료"가 아니라 고지 확인 미완료 상태로 표시', pkj.packet?.status === 'notice_pending' && !pkt.includes('총판 전달 준비 완료') && pkt.includes('필수 고지 확인 미완료'), `status=${pkj.packet?.status}`);
  check('AP3 대표 외 모두 403(검토자·편집자·상담원, 상담원은 배정돼도 불가), 무인증 401', (await pk(reviewerC, RS)).status === 403 && (await pk(editorC, RS)).status === 403 && (await pk(counselorC, RS)).status === 403 && (await pk(null, RS)).status === 401 && (await adm(`/api/admin/leads/${lid}/handoff`, reviewerC)).status === 403 && (await adm(`/api/admin/leads/${lid}/handoff`, counselorC)).status === 403);
  const hc = await adm(`/api/admin/leads/${lid}/handoff`, ownerC, { method: 'POST', body: JSON.stringify({ event: 'copied' }) });
  const hs0 = await adm(`/api/admin/leads/${lid}/handoff`, ownerC, { method: 'POST', body: JSON.stringify({ event: 'sent' }) });
  const hsp = await adm(`/api/admin/leads/${lid}/handoff`, ownerC, { method: 'POST', body: JSON.stringify({ event: 'sent', note: 'A총판 010-1234-5678' }) });
  const hs = await adm(`/api/admin/leads/${lid}/handoff`, ownerC, { method: 'POST', body: JSON.stringify({ event: 'sent', note: 'A총판' }) });
  const hl = await pj(await adm(`/api/admin/leads/${lid}/handoff`, ownerC));
  check('AP4 복사 기록 200, 전달 완료는 메모 없음·전화번호 메모 400, 고지 확인 미완료 건은 409(PACKET_NOT_READY)로 막힘, 이력에 열람·복사 순서 보존', hc.status === 200 && hs0.status === 400 && hsp.status === 400 && hs.status === 409 && ['viewed', 'copied'].every((e) => hl.items?.some((i) => i.event === e)) && !hl.items?.some((i) => i.event === 'sent'), `sent=${hs.status}`);
  check('AP5 감사 로그: 열람은 고정 사유 코드, 복사 기록 있음, 전달 완료는 막혀 기록 없음, 감사 로그 어디에도 이름·주소·이메일·전화 원문 없음, 이력 변조 불가', (await n(`select count(*)::int as n from core.audit_logs where action = 'pii.reveal' and detail ->> 'via' = 'dealer_packet' and target_id = '${lid}' and reason = 'dealer_handoff'`)) >= 1 && (await n(`select count(*)::int as n from core.audit_logs where action = 'handoff.copied' and target_id = '${lid}'`)) === 1 && (await n(`select count(*)::int as n from core.audit_logs where action = 'handoff.sent' and target_id = '${lid}'`)) === 0 && (await n(`select count(*)::int as n from core.audit_logs a where to_jsonb(a)::text like '%시험로%' or to_jsonb(a)::text like '%김플로우%' or to_jsonb(a)::text like '%e2e.test%' or to_jsonb(a)::text like '%8888%'`)) === 0 && await sql.unsafe(`update core.dealer_handoffs set note = 'x'`).then(() => false, () => true));
  const pgp = await adm(`/admin/leads/${lid}/packet`, ownerC, { redirect: 'manual' }); const pgh = await pgp.text();
  const pgn = await adm(`/admin/leads/${lid}/packet`, null, { redirect: 'manual' });
  check('AP6 관리자 화면 셸: 대표는 열람 사유 선택 화면(본문은 열기 전 없음), 무인증은 로그인으로 이동', pgp.status === 200 && pgh.includes('신청서 열기') && !pgh.includes('시험로') && !pgh.includes('김플로우') && [302, 303, 307, 308, 401].includes(pgn.status));
  // 실제 관리자 화면(브라우저): 사유 선택 → 신청서 열기 → 화면에 출력된 총판 전달용 문서 확인 → 복사·전달 버튼 상태
  try {
    const { chromium } = await import('playwright');
    const br = await chromium.launch();
    const ctx = await br.newContext({ viewport: { width: 1000, height: 1400 }, bypassCSP: true }) // next dev는 eval을 써서 운영 CSP와 충돌: 시험 서버에서만 우회;
    const [cn, ...cv] = ownerC.split('=');
    await ctx.addCookies([{ name: cn, value: cv.join('='), url: BASE }]);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin }).catch(() => {});
    const pg = await ctx.newPage();
    const diag = [];
    pg.on('console', (m) => { if (['error', 'warning'].includes(m.type())) diag.push(`c:${m.text().slice(0, 120)}`); });
    pg.on('pageerror', (e) => diag.push(`e:${e.message.slice(0, 120)}`));
    pg.on('requestfailed', (r) => diag.push(`rf:${r.url().slice(-60)}`));
    pg.on('response', (r) => { if (r.status() >= 400) diag.push(`r${r.status()}:${r.url().slice(-50)}`); });
    await pg.goto(`${BASE}/admin/leads/${lid}/packet`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1500); // 클라이언트 코드 연결(hydration) 대기
    await pg.selectOption('select[aria-label="열람 사유"]', 'dealer_handoff');
    await pg.click('button:has-text("신청서 열기")');
    await pg.waitForSelector('pre[data-field=packet]', { timeout: 15000 }).catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} url=${pg.url()} msg=${await pg.locator('[data-field=msg]').textContent().catch(() => 'n/a')} diag=${diag.slice(0, 6).join(' | ')}`); });
    const shown = await pg.locator('pre[data-field=packet]').textContent();
    const st = await pg.locator('[data-field=status]').textContent();
    const sentDisabled = await pg.locator('button:has-text("총판 전달 완료 기록")').isDisabled();
    let at2 = -1; const ord2 = ORDER.every((o) => { const k = shown.indexOf(`■ ${o}`); const ok = k > at2; at2 = k; return ok; });
    await pg.click('button:has-text("복사")');
    await pg.waitForFunction(() => document.querySelector('[data-field=msg]')?.textContent?.includes('복사 기록'), null, { timeout: 15000 }).catch(() => {});
    const clip = await pg.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    const hist = await pg.locator('[data-field=history]').textContent();
    await br.close();
    check('AP7 실제 관리자 화면: 총판 전달용 문서가 지정 순서로 출력되고(주소·이메일 복호화 표시), 고지 확인 미완료 상태·전달 완료 버튼 비활성, 복사 내용이 화면 문서와 같고 이력에 복사 기록', ord2 && shown.includes('시험로 12') && shown.includes('e2e.test@example.com') && /고지 확인 미완료/.test(st) && sentDisabled && (clip === '' || clip === shown) && /복사/.test(hist), `ord=${ord2} st=${st} sentDisabled=${sentDisabled} clip=${clip === shown ? 'same' : clip === '' ? 'n/a' : 'diff'}`);
    console.log('--- 관리자 화면 출력(가상 시험 데이터) ---\n' + shown + '\n---');
  } catch (e) { check('AP7 실제 관리자 화면 브라우저 검증', false, String(e.message).split('\n')[0]); }
  const fll = await adm('/api/admin/leads?limit=1', ownerC); const flt = await fll.text();
  check('FL4 관리자 목록(Next→DB): 방금 접수가 마스킹되어 보임, 원문 전화·이름 없음', fll.status === 200 && flt.includes('010-****-4321') && !flt.includes('8888') && !flt.includes('김플로우'), `status=${fll.status}`);
  const cm = await adm('/api/admin/leads?limit=1', counselorC); const cmt = await cm.text();
  check('FL4b 상담원은 본인 배정만 보므로 미배정 신규 접수·원문이 없고, 검토자는 목록 거부(403), 무인증 401', cm.status === 200 && !cmt.includes('4321') && !cmt.includes('8888') && !cmt.includes('김플로우') && (await adm('/api/admin/leads?limit=1', reviewerC)).status === 403 && (await adm('/api/admin/leads?limit=1')).status === 401);
  // 서버 게이트 차단 시나리오: 모두 접수 0건 증가, 사유 코드 503
  const blocked = async (name, r, code) => check(name, r.j?.code === code && r.j?.status === 503 && (await lc()) === lf0 + okFlows, `${r.raw}`);
  let okFlows = 1;
  await blocked('G1 서버 상수 문구가 DB 승인 문구와 한 글자 다르면 차단(NOTICE_HASH_MISMATCH)', await runFlow({ FLOW_TAMPER: '1', FLOW_IDEM: 'next-e2e-flow-0000000002' }), 'NOTICE_HASH_MISMATCH');
  await blocked('G2 접수 문서 버전 설정(privacy_policy_version)이 고지 버전과 다르면 차단(NOTICE_VERSION_MISMATCH)', await runFlow({ FLOW_IDEM: 'next-e2e-flow-0000000002' }, { version: false }), 'NOTICE_VERSION_MISMATCH');
  const cancel = await rev(reviewerC, { ...RB, decision: 'rejected', checks: { ...RC, conditions_checked: false }, reason: '승인 취소 시험' });
  await blocked('G3 승인 취소(이후 반려 기록) 즉시 차단(NOTICE_NOT_APPROVED)', await runFlow({ FLOW_IDEM: 'next-e2e-flow-0000000002' }), 'NOTICE_NOT_APPROVED');
  const reap = await rev(reviewerC, RB);
  const g3 = await runFlow({ FLOW_IDEM: 'next-e2e-flow-0000000003', FLOW_PHONE: '010-8888-4322' }); okFlows += g3.status === 0 ? 1 : 0;
  check('G3b 취소 기록 201 → 재승인 201 → 다시 접수 가능(+1건)', cancel.status === 201 && reap.status === 201 && g3.status === 0 && (await lc()) === lf0 + okFlows, g3.raw);
  // 문구가 더 추가되면 이전 승인은 최신이 아님(다시 검수 필요)
  await nad(ownerC, { version: 'next-e2e-v1', key: 'not_a_contract', body: '[검수용 시험 문구 2 — 실제 고지 아님]', reason: 'Next E2E 항목 추가' });
  const rl2 = await pj(await adm(rurl, reviewerC));
  check('RV8 승인 뒤 문구가 추가되면 이전 승인은 "최신 아님"으로 표시', rl2.items?.some((i) => i.version === 'next-e2e-v1' && i.decision === 'approved' && i.is_current === false) && rl2.items?.every((i) => !(i.version === 'next-e2e-v1' && i.decision === 'approved' && i.is_current === true)));
  await blocked('G4 승인 뒤 문구 변경(항목 추가) 즉시 차단(NOTICE_CHANGED)', await runFlow({ FLOW_IDEM: 'next-e2e-flow-0000000004' }), 'NOTICE_CHANGED');
  await blocked('G4b 서버 상수가 옛 항목 그대로면 키 불일치로 차단(NOTICE_KEYS_MISMATCH)', await runFlow({ FLOW_IDEM: 'next-e2e-flow-0000000004', FLOW_ONLY_KEYS: 'collection_purpose' }), 'NOTICE_KEYS_MISMATCH');
  const reap2 = await rev(reviewerC, RB);
  const g5 = await runFlow({ FLOW_IDEM: 'next-e2e-flow-0000000005', FLOW_PHONE: '010-8888-4323' }); okFlows += g5.status === 0 ? 1 : 0;
  check('G5 변경된 문구를 다시 검수·승인하면 새 문구로 접수 가능(+1건), 고지 노출 기록은 새 문구 2건 해시(누적 4건)', reap2.status === 201 && g5.status === 0 && (await lc()) === lf0 + okFlows && (await n(`select count(*)::int as n from pii.notice_exposures e join core.notice_texts t on t.version = e.doc_version and t.notice_key = e.notice_key and t.body_sha256 = e.body_sha256 where e.doc_version = 'next-e2e-v1'`)) === 1 + 1 + 2, g5.raw);
  check('G6 승인 취소·재승인·변경 모두 감사 기록(반려·승인) 남음, 작성자(대표)의 승인 시도는 계속 거부', (await n(`select count(*)::int as n from core.audit_logs where action = 'notice.review_rejected' and detail ->> 'version' = 'next-e2e-v1'`)) >= 2 && (await n(`select count(*)::int as n from core.audit_logs where action = 'notice.review_approved' and detail ->> 'version' = 'next-e2e-v1'`)) === 3 && (await rev(ownerC, RB)).status === 403);
  // 고객 화면이 보여 준 문구 해시가 서버 상수와 다르면(오래된·변조된 화면) 다음 접수부터 즉시 차단
  await blocked('G7 고객 화면이 보여 준 문구 해시 ≠ 서버 상수 해시면 DB 호출 전에 차단(NOTICE_HASH_MISMATCH 503)', await runFlow({ FLOW_STALE_CLIENT: '1', FLOW_IDEM: 'next-e2e-flow-0000000006', FLOW_PHONE: '010-8888-4328' }), 'NOTICE_HASH_MISMATCH');
  // 중간 실패 원자성: 리드 저장 뒤 신청서 저장이 실패하면 리드·고객·동의·고지 노출·신청서가 모두 취소돼야 한다(어긋난 불완전 상태 없음)
  const snap = async () => [await lc(), await n(`select count(*)::int as n from pii.customers`), await n(`select count(*)::int as n from pii.consents`), await n(`select count(*)::int as n from pii.notice_exposures`), await n(`select count(*)::int as n from pii.lead_applications`), await n(`select count(*)::int as n from core.audit_logs where action = 'application.save'`)].join(',');
  const s0 = await snap();
  const brk = await runFlow({ FLOW_APP: '1', FLOW_BREAK_APP: '1', FLOW_IDEM: 'next-e2e-flow-0000000007', FLOW_PHONE: '010-8888-4329' });
  const s1 = await snap();
  check('G8 신청서 저장이 실패하면 접수 전체가 취소된다(리드·고객·동의·고지 노출·신청서·저장 감사 모두 불변), 응답은 실패', brk.status !== 0 && brk.j?.ok === false && s1 === s0, `${s0} -> ${s1} ${brk.raw}`);
  const okApp = await runFlow({ FLOW_APP: '1', FLOW_IDEM: 'next-e2e-flow-0000000008', FLOW_PHONE: '010-8888-4330' }); okFlows += okApp.status === 0 ? 1 : 0;
  const s2 = await snap();
  check('G9 정상 접수(고지 승인 fixture)는 리드·고객·동의·고지 노출 2건·신청서·저장 감사가 함께 늘어난다', okApp.status === 0 && s2 === s0.split(',').map((v, i) => Number(v) + [1, 1, 1, 2, 1, 1][i]).join(','), `${s0} -> ${s2}`);
  const blk2 = await post('/api/leads', { name: '홍길동', phone: '010-1234-5678', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'next-e2e-v1', noticeKeys: ['collection_purpose'], noticeHashes: { collection_purpose: 'a'.repeat(64) }, idempotencyKey: 'next-e2e-lead-000000003', turnstileToken: 'ok' });
  check('RV9 검수 승인 이후에도 실제 서버는 코드 상수 미확정이라 접수 차단 유지(503), 접수 건수 변화 없음', blk2.status === 503 && blk2.j?.code === 'NOTICE_NOT_CONFIRMED' && (await lc()) === lf0 + okFlows, `status=${blk2.status}`);
  const page = await fetch(`${BASE}/consult/ai`);
  const html = await page.text();
  check('N14 /consult/ai 화면: 200, AI 안내·접수 양식 포함', page.status === 200 && html.includes('상담') && html.includes('가입 상담 신청'), `status=${page.status}`);
  // 고지 미확정(실제 상수) 환경의 실제 Next 화면: 상담 → 신청서 정보 수집은 되지만 고지 체크박스·접수는 없고, 총판 전달 준비 완료로 가지 않는다
  try {
    const { chromium } = await import('playwright');
    const br = await chromium.launch();
    const ctx = await br.newContext({ viewport: { width: 390, height: 1600 }, bypassCSP: true }); // next dev eval 때문에 시험 브라우저만 CSP 우회
    // 상담창 새 세션은 봇 확인 토큰 필요(PM 11/22 F1): Cloudflare 스크립트 대신 위젯별로 'ok' 토큰을 주는 가짜(서버 확인은 로컬 가짜 확인 서버)
    await ctx.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: "(function(){var n=0,c={};window.turnstile={render:function(el,o){var id='w'+(++n);c[id]=o.callback;setTimeout(function(){c[id]&&c[id]('ok');},10);return id;},reset:function(id){setTimeout(function(){c[id]&&c[id]('ok');},10);},remove:function(id){delete c[id];}};})();" }));
    const pg = await ctx.newPage();
    let leadPosts = 0;
    pg.on('request', (r) => { if (r.url().endsWith('/api/leads') && r.method() === 'POST') leadPosts++; });
    const leads0 = await lc();
    await pg.goto(`${BASE}/consult/ai`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1500);
    const ask = async (msg) => { const k = await pg.locator('[role=log] p').count(); await pg.fill('textarea[aria-label="상담 내용"]', msg); await pg.click('button:has-text("보내기")'); await pg.waitForFunction((c) => document.querySelectorAll('[role=log] p').length >= c + 3, k, { timeout: 20000 }); return (await pg.locator('[role=log] p').last().textContent()) ?? ''; };
    const t1 = await ask('요금이 궁금해요');
    await pg.fill('input[aria-label="설치주소"]', '서울시 가상구 화면로 7'); await pg.click('button:has-text("답하기")');
    await pg.click('[role=group] button:has-text("KT")');
    await pg.fill('input[aria-label="이메일"]', 'ui@example.com'); await pg.click('button:has-text("답하기")');
    for (const l of ['SK브로드밴드', '빠른 날짜', '기존 회선 있음', '확인했습니다', '확인했습니다']) await pg.click(`[role=group] button:has-text("${l}")`);
    const t2 = await ask('이제 접수하고 싶어요');
    const boxes = await pg.locator('.consent-box[aria-label="필수 고지"] input[type=checkbox]').count();
    const gate = (await pg.locator('.consent-box[aria-label="필수 고지"]').textContent()) ?? '';
    await pg.locator('form button[type=submit]').click({ timeout: 2000, force: true }).catch(() => {});
    await pg.waitForTimeout(500);
    await br.close();
    check('UI1 실제 Next 화면(고지 미확정): 상담 후 신청서 도우미가 이어 묻고, 모두 채워도 "접수 불가" 안내, 가짜 고지 체크박스 없음, 제출해도 접수 요청 0건·DB 저장 0건', /설치하실 곳의 주소/.test(t1) && /필수 고지 문구가 확정되기 전이라 접수는 아직 받을 수 없습니다/.test(t2) && boxes === 0 && /확정되기 전에는 상담 신청을 받지 않습니다/.test(gate) && leadPosts === 0 && (await lc()) === leads0, `t2=${t2.slice(0, 40)} boxes=${boxes} posts=${leadPosts}`);
  } catch (e) { check('UI1 실제 Next 화면 검증', false, String(e.message).split('\n')[0]); }
  // PM 11/22 P1-6: 같은 캠페인 키의 상담(consult_events)과 접수(leads.utm_campaign)가 ad_funnel_full에서 한 줄로 함께 집계된다(대표 API)
  try {
    const fr = await adm('/api/admin/ads/funnel', ownerC); const fj = await pj(fr);
    const row = (fj?.items ?? []).filter((x) => x.campaign === CAMP);
    const dbConsults = await n(`select count(*)::int as n from core.consult_events where campaign_key = '${CAMP}' and day between (now() at time zone 'Asia/Seoul')::date - 6 and (now() at time zone 'Asia/Seoul')::date`);
    const dbLeads = await n(`select count(*)::int as n from core.leads where utm_campaign = '${CAMP}'`);
    check('CV1 광고 전환 연결: 같은 캠페인 키의 상담·접수가 ad_funnel_full 한 줄에 함께 집계(상담≥1·접수≥1, 상담·접수 수 모두 DB 실제 값과 일치)',
      fr.status === 200 && row.length === 1 && row[0].consults >= 1 && row[0].leads >= 1 && row[0].leads === dbLeads && row[0].consults === dbConsults, `status=${fr.status} rows=${row.length} c=${row[0]?.consults}/${dbConsults} l=${row[0]?.leads}/${dbLeads}`);
  } catch (e) { check('CV1 광고 전환 연결', false, String(e.message).split('\n')[0]); }
  // PM 11/22: 실제 브라우저 단일 흐름(상담 → 수집 → 고지·동의 → 접수 → 관리자 → 총판 신청서). 고지 확정은 시험 전용 앱 사본에서만
  try {
    await runBrowserFlow({ sql, n, check, adm, pj, post, BASE, pubUrl, owner: ownerC, reviewer: reviewerC, editor: editorC, counselor: counselorC });
  } catch (e) { check('BF 실제 브라우저 단일 흐름', false, String(e.message).split('\n')[0]); }
} catch (e) { check('실행 중 예외 없음', false, String(e.message).split('\n')[0]); } finally { await sql.end(); fake.close(); }
const bad = results.filter((x) => !x).length;
console.log(`== Next 서버 E2E: pass=${results.length - bad} fail=${bad}`);
process.exit(bad === 0 && results.length > 0 ? 0 : 1);
