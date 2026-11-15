// 실제 Next 프로덕션 서버의 '기본 비활성' 경계 스모크(실HTTP·RSC).
// - 127.0.0.1에만 바인딩, 안전한 환경 변수만 전달(DB·Supabase·서명 키·광고 값 상속 안 함), 외부 접속 차단 사전 로드
// - 준비 대기 30초·전체 120초 제한, 성공·실패·타임아웃 모두 서버 정리
// - 응답 본문·환경 원문은 출력하지 않는다(검사 이름과 통과·실패만)
// - .next 빌드나 next가 없으면 실패. CI(CI=true)에서는 절대 건너뛰지 않는다.
//   로컬에서 FIDEON_ALLOW_SKIP_SERVER_SMOKE=1일 때만 '미실행'으로 표시하고 exit 0(통과로 세지 않음)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test-results', 'server-smoke');
const NET_LOG = path.join(OUT, 'blocked-network.log');
const DENY = path.join(ROOT, 'scripts', 'server-smoke', 'deny-network.cjs');
const READY_MS = 30_000;
const TOTAL_MS = 120_000;
const results = [];
const report = (name, ok, note = '') => results.push({ name, ok, note });

function finish(code, status) {
  mkdirSync(OUT, { recursive: true });
  const lines = [`상태: ${status}`, ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.note ? ` | ${r.note}` : ''}`)];
  writeFileSync(path.join(OUT, 'checks.txt'), lines.join('\n') + '\n');
  console.log('== server smoke (실제 Next 프로덕션 서버, 인증 비활성 기본값)');
  console.log(lines.join('\n'));
  process.exit(code);
}

// 1) 전제: next 설치·빌드 산출물
const req = createRequire(path.join(ROOT, 'package.json'));
let nextBin = null;
try { nextBin = path.join(path.dirname(req.resolve('next/package.json')), 'dist', 'bin', 'next'); } catch { /* 아래에서 처리 */ }
const missing = !nextBin ? 'next 미설치(npm ci 필요)' : !existsSync(path.join(ROOT, '.next', 'BUILD_ID')) ? '.next 빌드 없음(npm run build 필요)' : null;
if (missing) {
  const allowSkip = process.env.FIDEON_ALLOW_SKIP_SERVER_SMOKE === '1' && process.env.CI !== 'true';
  report('전제 조건', false, missing);
  finish(allowSkip ? 0 : 1, allowSkip ? '미실행(로컬 명시 허용, 통과로 세지 않음)' : '실패(전제 조건 없음)');
}

// 진행 스냅샷 문장(잠금 응답에 있으면 안 됨): 서버 스냅샷 파일의 한글 문자열 리터럴
const snapSrc = readFileSync(path.join(ROOT, 'src/server/admin/progressSnapshot.ts'), 'utf8');
const SNAP_TEXT = [...snapSrc.slice(snapSrc.indexOf('PROGRESS_SNAPSHOT')).matchAll(/'([^'\n]*[가-힣][^'\n]*)'/g)].map((m) => m[1]).filter((s) => s.length >= 4);
if (SNAP_TEXT.length < 5) { report('스냅샷 문장 추출', false, `추출 ${SNAP_TEXT.length}개`); finish(1, '실패'); }
const MOCK_TEXT = ['010-****-0006', '010-****-0007', '테*트', '매장 카메라 4대'];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// 2) 차단 장치 자체 확인: 사전 로드한 node가 외부 주소에 접속하지 못하고 기록이 남는지
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const selfTest = spawnSync(process.execPath, ['--require', DENY, '-e',
  "require('node:net').connect(443,'192.0.2.1').on('error',()=>process.exit(3)).on('connect',()=>process.exit(0));setTimeout(()=>process.exit(4),3000)"], {
  env: { PATH: process.env.PATH, FIDEON_SMOKE_NET_LOG: NET_LOG }, timeout: 10_000,
});
const selfBlocked = existsSync(NET_LOG) && readFileSync(NET_LOG, 'utf8').trim().split('\n').length >= 1;
report('N0 외부 접속 차단 장치 동작(문서용 주소 192.0.2.1)', selfTest.status === 3 && selfBlocked);
rmSync(NET_LOG, { force: true });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  PORT: String(port),
  HOSTNAME: '127.0.0.1',
  NEXT_TELEMETRY_DISABLED: '1',
  NODE_OPTIONS: `--require ${DENY}`,
  FIDEON_SMOKE_NET_LOG: NET_LOG,
};
const server = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'], detached: false });
let exited = false;
server.on('exit', () => { exited = true; });
const stop = async () => {
  if (exited) return;
  server.kill('SIGTERM');
  for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
  if (!exited) server.kill('SIGKILL');
};
const total = setTimeout(async () => { report('전체 시간 제한', false, `${TOTAL_MS / 1000}초 초과`); await stop(); finish(1, '실패(시간 초과)'); }, TOTAL_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stop(); process.exit(1); });

const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });

try {
  // 3) 준비 대기
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < READY_MS && !exited) {
    try { if ((await get('/robots.txt')).status === 200) { ready = true; break; } } catch { /* 아직 준비 안 됨 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  report('서버 준비(127.0.0.1 전용)', ready, ready ? '' : exited ? '서버 종료됨' : `${READY_MS / 1000}초 초과`);
  if (!ready) throw new Error('not ready');

  const noStore = (r) => (r.headers.get('cache-control') ?? '').includes('no-store');
  const noIndexHeader = (r) => (r.headers.get('x-robots-tag') ?? '') === 'noindex, nofollow';
  const leaks = (text, list) => list.filter((s) => text.includes(s)).length;

  // H1 진행판 HTML
  let r = await get('/admin/progress');
  let t = await r.text();
  report('H1 /admin/progress HTML: 200·잠금 문구', r.status === 200 && t.includes('이 화면은 관리자 인증 연결 후 열립니다.'));
  report('H1 /admin/progress HTML: 스냅샷 문장 0개', leaks(t, SNAP_TEXT) === 0, `포함 ${leaks(t, SNAP_TEXT)}개`);
  report('H1 /admin/progress HTML: no-store·X-Robots-Tag', noStore(r) && noIndexHeader(r));
  // H2 진행판 RSC
  r = await get('/admin/progress', { RSC: '1' });
  t = await r.text();
  const ctype = r.headers.get('content-type') ?? '';
  report('H2 /admin/progress RSC: text/x-component·잠금 문구', r.status === 200 && ctype.includes('text/x-component') && t.includes('이 화면은 관리자 인증 연결 후 열립니다.'), ctype.split(';')[0]);
  report('H2 /admin/progress RSC: 스냅샷 문장 0개', leaks(t, SNAP_TEXT) === 0, `포함 ${leaks(t, SNAP_TEXT)}개`);
  report('H2 /admin/progress RSC: no-store', noStore(r));
  // H3 관리자 리드 API
  for (const p of ['/api/admin/leads', '/api/admin/leads/mock-0006']) {
    r = await get(p);
    const body = await r.text();
    let code = null;
    try { code = JSON.parse(body).code; } catch { /* 형식 오류 */ }
    report(`H3 ${p}: 503 ADMIN_AUTH_DISABLED·no-store·가상 데이터 0`, r.status === 503 && code === 'ADMIN_AUTH_DISABLED' && noStore(r) && leaks(body, MOCK_TEXT) === 0);
  }
  // H4 관리자 화면(HTML·RSC)
  for (const [label, h] of [['HTML', {}], ['RSC', { RSC: '1' }]]) {
    r = await get('/admin', h);
    t = await r.text();
    report(`H4 /admin ${label}: 잠금·가상 리드 0·no-store·X-Robots-Tag`, r.status === 200 && t.includes('관리자 화면은 인증 연결 후 열립니다.') && leaks(t, MOCK_TEXT) === 0 && noStore(r) && noIndexHeader(r));
  }
  r = await get('/admin/login');
  t = await r.text();
  report('H5 /admin/login: 미리보기(인증 서버 미연결)·no-store', r.status === 200 && t.includes('인증 서버 미연결') && noStore(r));
  // H6 검색
  r = await get('/robots.txt');
  t = await r.text();
  report('H6 /robots.txt: 전체 차단·Sitemap 없음', r.status === 200 && /Disallow:\s*\/\s*$/m.test(t) && !/^Allow:/mi.test(t) && !/sitemap/i.test(t));
  r = await get('/sitemap.xml');
  t = await r.text();
  report('H6 /sitemap.xml: 항목 0개', r.status === 200 && !/<url>/i.test(t) && !/<loc>/i.test(t));
  r = await get('/');
  t = await r.text();
  report('H7 /: noindex 메타', r.status === 200 && /<meta name="robots" content="noindex, nofollow"/.test(t));
  // H8 서버가 외부로 나가려 한 흔적
  const blocked = existsSync(NET_LOG) ? readFileSync(NET_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  report('H8 서버의 외부 접속 시도 0건', blocked === 0, `차단 ${blocked}건`);
} catch (e) {
  if (!(e instanceof Error && e.message === 'not ready')) report('검사 실행', false, '예외 발생(내용 비공개)');
} finally {
  clearTimeout(total);
  await stop();
}
report('서버 정리', exited);
finish(results.every((x) => x.ok) ? 0 : 1, results.every((x) => x.ok) ? '통과' : '실패');
