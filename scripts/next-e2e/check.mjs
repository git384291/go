// 실제 Next 서버에 HTTP로 요청하고, 실제 PostgreSQL을 직접 조회해 결과를 확인한다. 응답 본문의 개인정보·비밀은 출력하지 않는다.
import postgres from 'postgres';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
const chat = (extra = {}, ip = '198.51.100.7') => post('/api/consult/chat', { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금이 궁금해요', campaign: CAMP, ...extra }, { 'x-forwarded-for': ip });
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
  const L = (tok) => post('/api/leads', { name: '홍길동', phone: '010-1234-5678', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['collection_purpose', 'not_a_contract', 'policy_confirm'], idempotencyKey: 'next-e2e-lead-000000001', turnstileToken: tok });
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
  const ll = await adm('/api/admin/leads', ownerC);
  const lt = await ll.text();
  check('N13 관리자 접수 목록(Next→DB): 200, 마스킹된 전화번호 표시, 원문 전화·이름 없음', ll.status === 200 && lt.includes('010-****-1234') && !lt.includes('7777') && !lt.includes('김이투이'), `status=${ll.status} ${ll.status === 200 ? '' : lt.slice(0, 120)}`);
  check('N13b 무인증·검토자 외 역할 규칙: 무인증 목록 401', (await adm('/api/admin/leads')).status === 401);
  const page = await fetch(`${BASE}/consult/ai`);
  const html = await page.text();
  check('N14 /consult/ai 화면: 200, AI 안내·접수 양식 포함', page.status === 200 && html.includes('상담') && html.includes('가입 상담 신청'), `status=${page.status}`);
} catch (e) { check('실행 중 예외 없음', false, String(e.message).split('\n')[0]); } finally { await sql.end(); fake.close(); }
const bad = results.filter((x) => !x).length;
console.log(`== Next 서버 E2E: pass=${results.length - bad} fail=${bad}`);
process.exit(bad === 0 && results.length > 0 ? 0 : 1);
