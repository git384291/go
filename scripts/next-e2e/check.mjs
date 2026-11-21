// 실제 Next 서버에 HTTP로 요청하고, 실제 PostgreSQL을 직접 조회해 결과를 확인한다. 응답 본문의 개인정보·비밀은 출력하지 않는다.
import postgres from 'postgres';

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
  // 접수: 봇 확인(Turnstile) 없이는 서버가 막는다(외부 호출 없음). 필수 고지 미확정 상태에서 접수 0건
  const l0 = await n(`select count(*)::int as n from core.leads`);
  const lead = await post('/api/leads', { name: '홍길동', phone: '010-1234-5678', interest: 'internet_tv', consentCollection: true, idempotencyKey: 'next-e2e-lead-000000001', turnstileToken: 'x' });
  check('N8 접수 API: 봇 확인 없이는 거부, DB 접수 0건 증가', lead.status >= 400 && lead.j?.ok !== true && (await n(`select count(*)::int as n from core.leads`)) === l0, `status=${lead.status} code=${lead.j?.code}`);
  // 관리자 API: 인증 없이는 열리지 않고 DB를 바꾸지 않는다
  const au0 = await n(`select count(*)::int as n from core.audit_logs`);
  for (const [p, body] of [['/api/admin/ai/budget', { limitKrw: 100, reason: '무인증 시도' }], ['/api/admin/ads/run', { action: 'collect', campaign: CAMP, day: '2026-11-20' }], ['/api/admin/ads/budget', { action: 'approve', campaign: CAMP }]]) {
    const r = await post(p, body);
    check(`N9 무인증 ${p}: 열리지 않음(401/403/503)`, [401, 403, 503, 422].includes(r.status) && r.j?.ok !== true, `status=${r.status}`);
  }
  const g = await fetch(`${BASE}/api/admin/ai/budget`);
  check('N10 무인증 AI 한도 조회: 열리지 않음', g.status !== 200, `status=${g.status}`);
  check('N11 무인증 요청이 DB(감사·한도)를 바꾸지 않음', (await n(`select count(*)::int as n from core.audit_logs`)) === au0 && (await n(`select monthly_limit_krw as n from core.ai_budget_config where singleton`)) === 0);
  const page = await fetch(`${BASE}/consult/ai`);
  const html = await page.text();
  check('N12 /consult/ai 화면: 200, AI 안내·접수 양식 포함', page.status === 200 && html.includes('상담') && html.includes('가입 상담 신청'), `status=${page.status}`);
} catch (e) { check('실행 중 예외 없음', false, String(e.message).split('\n')[0]); } finally { await sql.end(); }
const bad = results.filter((x) => !x).length;
console.log(`== Next 서버 E2E: pass=${results.length - bad} fail=${bad}`);
process.exit(bad === 0 && results.length > 0 ? 0 : 1);
