// 실제 Next 프로덕션 서버의 '기본 비활성' 경계 스모크(실HTTP·RSC).
// - 127.0.0.1에만 바인딩, 안전한 환경 변수만 전달(DB·Supabase·서명 키·광고 값 상속 안 함)
// - Next는 실행 루트의 .env* 파일을 스스로 읽는다 → 실제 설정 파일이 없는 격리 루트에서 실행(isolate.mjs)하고,
//   격리 루트에 .env*가 있으면 시작 전 중단. 닫힌 값(인증·접수·검색 꺼짐)을 명시해 넘긴다.
// - deny-network: 테스트용 Node TCP·TLS·DNS 계측(OS 네트워크 sandbox 아님. UDP·외부 프로세스·원시 소켓은 막는다고 보장하지 않음).
//   H8은 '이번 실행에서 관찰된 Node 접속 시도 0'이며 완전한 네트워크 격리 보장이 아니다.
// - 준비 대기 30초·전체 300초 제한(기본 + 출처 변형 2회 + 상담 시안 켠 서버 1회 순차 재기동), 성공·실패·타임아웃·신호 모두 같은 정리 경로(lifecycle.mjs)
//   서버 종료를 확인하지 못하면 다음 서버를 띄우지 않고, 격리 루트 정리도 보류하며 실패로 끝낸다
// - 응답 본문·환경 원문은 출력하지 않는다(검사 이름과 통과·실패만)
// - .next 빌드나 next가 없으면 실패. CI(CI=true)에서는 절대 건너뛰지 않는다.
//   로컬에서 FIDEON_ALLOW_SKIP_SERVER_SMOKE=1일 때만 '미실행'으로 표시하고 exit 0(통과로 세지 않음)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dotenvFilesIn, prepareIsolatedRoot } from './isolate.mjs';
import { createAbortHandler, createServerManager, finalCleanup } from './lifecycle.mjs';
import { isHtmlNotFound, isRscNotFound } from './notFound.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test-results', 'server-smoke');
const NET_LOG = path.join(OUT, 'blocked-network.log');
const DENY = path.join(ROOT, 'scripts', 'server-smoke', 'deny-network.mjs');
const READY_MS = 30_000;
const TOTAL_MS = 300_000; // 기본 + 출처 변형 2회(순차 재기동)
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
const selfTest = spawnSync(process.execPath, ['--import', DENY, '-e',
  "require('node:net').connect(443,'192.0.2.1').on('error',()=>process.exit(3)).on('connect',()=>process.exit(0));setTimeout(()=>process.exit(4),3000)"], {
  env: { PATH: process.env.PATH, FIDEON_SMOKE_NET_LOG: NET_LOG }, timeout: 10_000,
});
const selfBlocked = existsSync(NET_LOG) && readFileSync(NET_LOG, 'utf8').trim().split('\n').length >= 1;
report('N0 외부 접속 차단 장치 동작(문서용 주소 192.0.2.1)', selfTest.status === 3 && selfBlocked);
rmSync(NET_LOG, { force: true });

// 2-1) 원본 루트 dotenv 파일: 이름 존재만 기록(내용 미열람)
const srcDotenv = dotenvFilesIn(ROOT);
report('E0 원본 루트 dotenv 파일(이름만 확인, 내용 미열람)', true, srcDotenv.length ? `${srcDotenv.length}개 있음 → 격리 루트로 우회` : '없음');

// 2-2) fixture 증명: 가짜 dotenv가 있는 원본에서 만든 격리 루트는 그 값을 로드하지 않는다(@next/env 실제 로더)
{
  const fx = mkdtempSync(path.join(os.tmpdir(), 'fideon-smoke-fixture-'));
  let isolated = null;
  try {
    mkdirSync(path.join(fx, '.next'));
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(fx, 'node_modules'), 'dir');
    writeFileSync(path.join(fx, 'package.json'), '{"private":true}');
    writeFileSync(path.join(fx, '.env.production.local'), 'FIDEON_SMOKE_FIXTURE_FLAG=fixture-loaded\nADMIN_AUTH_MODE=supabase\nDATABASE_URL=postgres://fixture@127.0.0.1:1/fixture\n');
    const { loadEnvConfig } = req('@next/env');
    const probe = (dir) => {
      // 로더가 process.env를 바꾸므로 확인용 키만 비교하고 바로 되돌린다
      const keys = ['FIDEON_SMOKE_FIXTURE_FLAG', 'ADMIN_AUTH_MODE', 'DATABASE_URL'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      for (const k of keys) delete process.env[k];
      const r = loadEnvConfig(dir, false, { info() {}, error() {} }, true);
      const loaded = keys.filter((k) => r.combinedEnv[k] !== undefined).length;
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      return loaded;
    };
    const control = probe(fx);
    isolated = prepareIsolatedRoot(fx);
    const inIsolated = probe(isolated.root);
    report('E1 fixture 대조군: 원본 경로에서는 가짜 dotenv 3개 값이 로드됨', control === 3, `로드 ${control}개`);
    report('E2 fixture 격리 루트: dotenv 값 0개 로드, 격리 루트에 .env* 없음', inIsolated === 0 && dotenvFilesIn(isolated.root).length === 0, `로드 ${inIsolated}개`);
  } catch {
    report('E1/E2 fixture 격리 증명', false, '예외 발생(내용 비공개)');
  } finally {
    isolated?.cleanup();
    rmSync(fx, { recursive: true, force: true });
  }
}

// 2-3) 실제 실행용 격리 루트(시작 전 .env* 존재 시 중단)
let runRoot;
try {
  runRoot = prepareIsolatedRoot(ROOT);
  report('E3 실행 격리 루트 준비(.env* 없음 확인)', true);
} catch (e) {
  report('E3 실행 격리 루트 준비', false, e instanceof Error && e.message.startsWith('ISOLATE_') ? e.message : '예외');
  finish(1, '실패(격리 실패 — 서버 시작 안 함)');
}

// 격리 루트에서 Next 프로덕션 서버를 띄운다. env는 닫힌 기본값 + extra(가짜 값만)이며 현재 프로세스 환경을 상속하지 않는다.
let base = '';
const manager = createServerManager({
  spawnChild: (extra) => {
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(extra.__port),
      HOSTNAME: '127.0.0.1',
      NEXT_TELEMETRY_DISABLED: '1',
      // 닫힌 값 명시(설정 파일이 있어도 이 값이 우선. 격리 루트에는 설정 파일 자체가 없다)
      ADMIN_AUTH_MODE: 'disabled',
      LEAD_INTAKE_MODE: 'disabled',
      NEXT_PUBLIC_LEAD_FORM_ENABLED: 'false',
      SEARCH_INDEXING: 'deny',
      NODE_OPTIONS: `--import ${DENY}`,
      FIDEON_SMOKE_NET_LOG: NET_LOG,
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== '__port')),
    };
    const child = spawn(process.execPath, [nextBin, 'start', runRoot.root, '-H', '127.0.0.1', '-p', String(extra.__port)], { cwd: runRoot.root, env, stdio: ['ignore', 'ignore', 'ignore'], detached: false });
    return { kill: (sig) => child.kill(sig), onExit: (cb) => child.on('exit', cb) };
  },
  probe: async () => {
    try { return (await fetch(base + '/robots.txt', { signal: AbortSignal.timeout(10_000) })).status === 200; } catch { return false; }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  readyMs: READY_MS,
});
async function startServer(extra = {}) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const s = await manager.start({ ...extra, __port: String(port) });
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  return { get, ready: s.ok && s.ready, exited: () => !!s.exited, started: s.ok };
}
const abort = createAbortHandler({ manager, report, cleanupRoot: () => runRoot.cleanup(), finish });
const total = setTimeout(() => { abort(`전체 시간 제한 ${TOTAL_MS / 1000}초 초과`); }, TOTAL_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { abort(`신호 ${sig}`); });
/** 순차 실행 중 서버 종료: 확인 실패면 다음 서버를 띄우지 않도록 예외로 중단 */
async function stopOrThrow(label) {
  const ok = await manager.stop();
  report(label, ok, ok ? '' : '종료 미확인');
  if (!ok) throw new Error('stop failed');
}

const noStore = (r) => (r.headers.get('cache-control') ?? '').includes('no-store');
const noIndexHeader = (r) => (r.headers.get('x-robots-tag') ?? '') === 'noindex, nofollow';
const leaks = (text, list) => list.filter((s) => text.includes(s)).length;
const netAttempts = () => (existsSync(NET_LOG) ? readFileSync(NET_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0);

try {
  // 3) 기본값 서버
  const current = await startServer();
  report('서버 준비(127.0.0.1 전용)', current.ready, current.ready ? '' : current.exited() ? '서버 종료됨' : `${READY_MS / 1000}초 초과`);
  if (!current.ready) throw new Error('not ready');
  const { get } = current;

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
  // H9 인터넷TV 상세: 상품 안내 패널은 꺼짐, 검수한 공식 접수 링크 1개와 준비 중 안내·검색 차단 유지
  const GUIDE_MARKS = ['data-product-guide', 'data-guide-topic', '규칙 기반 상품 안내', '자주 묻는 질문'];
  const OFFICIAL_INTAKE_MARKS = ['data-official-intake'];
  const OFFICIAL_INTAKE_URL = 'https://form.naver.com/response/By757YMGRuN';
  for (const [label, h] of [['HTML', {}], ['RSC', { RSC: '1' }]]) {
    r = await get('/products/internet-tv', h);
    t = await r.text();
    const robots = label === 'HTML' ? /<meta name="robots" content="noindex, nofollow"/.test(t) : true;
    const guideMarks = leaks(t, GUIDE_MARKS);
    const intakeMarks = leaks(t, OFFICIAL_INTAKE_MARKS);
    report(`H9 /products/internet-tv ${label}: 안내 패널 0·공식 접수 링크 1·준비 중 안내${label === 'HTML' ? '·noindex' : ''}`,
      r.status === 200 && guideMarks === 0 && intakeMarks === 1 && t.includes(OFFICIAL_INTAKE_URL) && t.includes('온라인 상담 서비스 준비 중') && robots,
      `안내 표식 ${guideMarks}개, 접수 표식 ${intakeMarks}개`);
  }
  // H10 카카오톡 상품 문의(기본 꺼짐, PM 6938169689): 상담·인터넷TV HTML·RSC에 카톡 링크·버튼·안내 표식 0, 준비 중·잠금 유지
  const KAKAO_MARKS = ['data-kakao-inquiry', 'btn-kakao', 'kakao.com', '카카오톡', 'kakao-inquiry-note', '#kakao-channel'];
  for (const [path, lockText] of [['/consult', '지금은 상담 신청을 받지 않습니다'], ['/products/internet-tv', '온라인 상담 서비스 준비 중']]) {
    for (const [label, h] of [['HTML', {}], ['RSC', { RSC: '1' }]]) {
      r = await get(path, h);
      t = await r.text();
      const robots = label === 'HTML' ? /<meta name="robots" content="noindex, nofollow"/.test(t) : true;
      report(`H10 ${path} ${label}: 카톡 문의 표식 0·준비 중/잠금 안내${label === 'HTML' ? '·noindex' : ''}`,
        r.status === 200 && leaks(t, KAKAO_MARKS) === 0 && t.includes(lockText) && robots, `표식 ${leaks(t, KAKAO_MARKS)}개`);
    }
  }
  // H11 상담 시안(비공개, 기본 꺼짐, PM 7013332604·7014853871): 환경 변수 없으면 HTML·RSC 모두 404이고 화면 문구가 응답에 없다
  const CONSULT_MARKS = ['가정용', 'AI 도우미', '가상 대화', '집에서 쓰실 건가요', '모의 전화', 'cp-wrap'];
  for (const [label, h] of [['HTML', {}], ['RSC', { RSC: '1' }]]) {
    r = await get('/preview/consult-chat', h);
    t = await r.text();
    // HTML은 404 상태. RSC는 404 또는 200 + text/x-component + 스트림 오류 행의 not-found digest(notFound.mjs, 본문 문자열 검색 아님)
    const nf = label === 'HTML' ? { ok: isHtmlNotFound({ status: r.status }), via: '404 상태' } : isRscNotFound({ status: r.status, contentType: r.headers.get('content-type'), body: t });
    // 진단에는 상태·허용된 digest(판정 근거)·표식 수만 남긴다(응답 본문 원문은 로그에 붙이지 않는다)
    report(`H11 /preview/consult-chat ${label}(기본 꺼짐): 없는 페이지로 응답·상담 시안 문구 0`, nf.ok && leaks(t, CONSULT_MARKS) === 0, `상태 ${r.status}, 판정 ${nf.via ?? '불일치'}, 표식 ${leaks(t, CONSULT_MARKS)}개`);
  }
  // H8 서버가 외부로 나가려 한 흔적
  const blocked = netAttempts();
  report('H8 서버의 외부 접속 시도 0건', blocked === 0, `차단 ${blocked}건`);
  await stopOrThrow('서버 정리(종료 이벤트 확인)');

  // 4) 관리자 리드 출처 변형(PM 6916935437): 서버를 순차 재기동해 db·invalid에서도 목록·mock·내부 값이 나오지 않는지 확인
  //    db 변형의 DATABASE_URL은 문법상 로컬 폐기 시험 DB처럼 보이는 가짜 값(열린 포트 없음). production 서버이므로 준비됨이 되면 안 된다.
  const FAKE_DB_URL = 'postgres://smoke@127.0.0.1:1/fideon_lrs_1_abcdef01';
  const INTERNAL = ['fideon_lrs', '127.0.0.1:1', 'postgres://', 'smoke@', 'ADMIN_LEADS_SOURCE', 'DATABASE_URL', '010-****-'];
  const variants = [
    { id: 'S1', label: 'source=db(production + 폐기 DB처럼 보이는 가짜 URL)', extra: { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: FAKE_DB_URL }, page: '이 환경에서는 목록을 불러오지 않습니다', list: 'LEADS_READ_DISABLED', detail: 'LEADS_DETAIL_UNAVAILABLE' },
    { id: 'S2', label: 'source=invalid(DB)', extra: { ADMIN_LEADS_SOURCE: 'DB' }, page: '관리자 목록 설정을 확인할 수 없어', list: 'LEADS_SOURCE_INVALID', detail: 'LEADS_SOURCE_INVALID' },
  ];
  for (const v of variants) {
    rmSync(NET_LOG, { force: true });
    const vs = await startServer(v.extra);
    report(`${v.id} ${v.label}: 서버 준비`, vs.ready);
    if (!vs.ready) throw new Error('not ready');
    for (const [label, h] of [['HTML', {}], ['RSC', { RSC: '1' }]]) {
      r = await vs.get('/admin', h);
      t = await r.text();
      const ok = r.status === 200 && t.includes(v.page) && !t.includes('관리자 화면은 인증 연결 후 열립니다.') && leaks(t, MOCK_TEXT) === 0 && !t.includes('가상 데이터') && leaks(t, INTERNAL) === 0 && noStore(r) && noIndexHeader(r);
      report(`${v.id} /admin ${label}: 잠금 문구·mock 0·행·내부 값 0·no-store·X-Robots-Tag`, ok);
    }
    for (const [p, code] of [['/api/admin/leads', v.list], ['/api/admin/leads/mock-0006', v.detail]]) {
      r = await vs.get(p);
      const body = await r.text();
      let got = null;
      try { got = JSON.parse(body).code; } catch { /* 형식 오류 */ }
      report(`${v.id} ${p}: 503 ${code}·no-store·nosniff·가상·내부 값 0`, r.status === 503 && got === code && noStore(r) && (r.headers.get('x-content-type-options') ?? '') === 'nosniff' && leaks(body, MOCK_TEXT) === 0 && leaks(body, INTERNAL) === 0);
    }
    const n = netAttempts();
    report(`${v.id} 서버의 외부 접속 시도 0건`, n === 0, `차단 ${n}건`);
    await stopOrThrow(`${v.id} 서버 정리(종료 이벤트 확인)`);
  }

  // S3 상담 시안 켠 서버(가짜 env 값 'true'만, 비밀·실제 연결 없음): 200·noindex·화면 표식, 실제 브라우저에서 끝까지 조작
  {
    rmSync(NET_LOG, { force: true });
    const vs = await startServer({ CONSULT_PREVIEW_ENABLED: 'true' });
    report('S3 상담 시안 켬: 서버 준비', vs.ready);
    if (!vs.ready) throw new Error('not ready');
    r = await vs.get('/preview/consult-chat');
    t = await r.text();
    report('S3 /preview/consult-chat HTML: 200·noindex 메타·첫 질문·AI 안내', r.status === 200 && /<meta name="robots" content="[^"]*noindex/.test(t) && t.includes('집에서 쓰실 건가요') && t.includes('AI 도우미'), `상태 ${r.status}`);
    report('S3 HTML: 입력칸·링크 표식 없음(서버 렌더 기준)', !/<input|<textarea|href="tel:/i.test(t));
    r = await vs.get('/preview/consult-chat', { RSC: '1' });
    t = await r.text();
    report('S3 /preview/consult-chat RSC: 200·text/x-component', r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/x-component'));
    // 실제 브라우저(CI가 설치한 Chromium, 390폭 하나만). 320/390 전 경로 시험은 scripts/preview/consult-preview.mjs(가상 주소 fixture)가 맡는다.
    // 두 흐름 모두 하이드레이션 후 끝까지 → 요약 → 이전 답 고치기 → 낡은 요약 제거 → 다시 골라 새 요약까지, 입력칸·저장소·외부 요청·오류 0
    const runFlow = async (browser, flow) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, timezoneId: 'Asia/Seoul' });
      const external = [];
      await ctx.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith(base + '/') || u === base) return route.continue(); external.push(u); return route.abort(); });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e)));
      try {
        await page.goto(base + '/preview/consult-chat', { waitUntil: 'networkidle', timeout: 20_000 });
        const pick = (text) => page.locator('.cp-choice', { hasText: text }).first().click({ timeout: 10_000 });
        const summary = () => page.locator('.cp-summary').innerText({ timeout: 10_000 });
        for (const x of flow.first) await pick(x);
        const sum1 = await summary();
        await page.locator('details.cp-history > summary').click();
        await page.locator('.cp-history-list li', { hasText: flow.editQuestion }).locator('.cp-edit').click();
        const gone = (await page.locator('.cp-summary').count()) === 0;
        for (const x of flow.again) await pick(x);
        const sum2 = await summary();
        const noInput = (await page.locator('input, textarea').count()) === 0;
        const stor = await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length);
        const c1 = flow.sum1.every((k) => sum1.includes(k));
        const c2 = flow.sum2.every((k) => sum2.includes(k)) && flow.gone.every((k) => !sum2.includes(k));
        return { ok: c1 && gone && c2 && noInput && stor === 0 && external.length === 0 && errs.length === 0, note: `첫 요약 ${c1}, 고친 직후 요약 제거 ${gone}, 새 요약 ${c2}, 외부 요청 ${external.length}, 오류 ${errs.length}` };
      } finally {
        await ctx.close().catch(() => {});
      }
    };
    // 담당자 연결 모의 예시(PM 7029405014): 실제 서버·실제 브라우저, 320/390폭, 키보드로 사례 전환·반복 선택, 한 번에 안내 하나만
    const HX = { off: '토요일 설치 가능 여부는 지금 확인해 드릴 수 없어요', unavailable: '현재 담당자 연결을 확인할 수 없어요', unknown: '담당자에게 전달됐는지 확인하지 못했어요', confirmed: '담당자가 이 문의를 확인했어요' };
    const runHandoff = async (browser, width) => {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, timezoneId: 'Asia/Seoul' });
      const external = [];
      await ctx.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith(base + '/') || u === base) return route.continue(); external.push(u); return route.abort(); });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e)));
      try {
        await page.goto(base + '/preview/consult-chat', { waitUntil: 'networkidle', timeout: 20_000 });
        await page.locator('details[data-aux="examples"] > summary').click();
        await page.locator('details[data-handoff-fold] > summary').click();
        const start0 = (await page.locator('[data-handoff-result]').count()) === 0 && (await page.locator('.cp-handoff-case').count()) === 4;
        let ok = start0; const bad = [];
        for (const [i, id] of ['off', 'unavailable', 'unknown', 'confirmed', 'confirmed', 'off', 'confirmed', 'unknown'].entries()) {
          await page.locator(`[data-case="${id}"]`).focus();
          await page.keyboard.press(i % 2 === 0 ? 'Enter' : 'Space');
          const cnt = await page.locator('[data-handoff-result]').count();
          const txt = cnt === 1 ? await page.locator('[data-handoff-result]').innerText() : '';
          const only = Object.entries(HX).every(([k, v]) => (k === id) === txt.includes(v));
          const badge = await page.locator('.cp-handoff-mock').count();
          const clip = await page.$$eval('[data-handoff-result], [data-handoff-result] p, .cp-handoff-mock', (els) => els.every((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= window.innerWidth + 0.5));
          const pass = cnt === 1 && only && badge === (id === 'confirmed' ? 1 : 0) && clip;
          if (!pass) { ok = false; bad.push(`${i}:${id}`); }
        }
        const noOver = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        const noInput = (await page.locator('input, textarea').count()) === 0;
        const stor = await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length);
        return { ok: ok && noOver && noInput && stor === 0 && external.length === 0 && errs.length === 0, note: `사례 8회 선택 ${ok}${bad.length ? ' 실패 ' + bad.join(',') : ''}, 가로 넘침 없음 ${noOver}, 외부 요청 ${external.length}, 오류 ${errs.length}` };
      } finally {
        await ctx.close().catch(() => {});
      }
    };
    const flows = [
      { name: '가정용(이사·3~4대·매일 → 이유 고치기 → 약정 종료 비교·거의 안 봐요)', first: ['가정용', '이사해서 새로 알아봐요', '3~4대', '매일 봐요'], editQuestion: '어떤 이유로',
        again: ['쓰던 약정이 끝나서 비교해요', '3~4대', '거의 안 봐요'], sum1: ['가장 먼저 비교할 점', '동시 사용과 셋톱박스 임대료'],
        sum2: ['쓰던 약정이 끝나서 비교해요', '해지 비용'], gone: ['이사해서 새로 알아봐요', '매일 봐요', '동시 사용과 셋톱박스 임대료'] },
      { name: '사업장(결제 중단·TV 미정 → TV 장소 고치기 → 홀 재선택)', first: ['매장·사무실용', '카드 결제·배달 주문이 멈추는 거예요', '아직 정하지 못했어요'], editQuestion: 'TV는 어디에서',
        again: ['손님이 보는 홀·객실에 둬요'], sum1: ['가장 먼저 비교할 점', '아직 정하지 못했어요', '직원 휴게실인지'],
        sum2: ['손님이 보는 홀·객실에 둬요', '해당 장소에서 이용 가능한 상품인지'], gone: ['아직 정하지 못했어요', '직원 휴게실인지'] },
    ];
    let browser = null;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
      for (const f of flows) {
        let res;
        try { res = await runFlow(browser, f); } catch (e) { res = { ok: false, note: `브라우저 단계 실패(${e instanceof Error ? e.message.split('\n')[0].slice(0, 80) : '알 수 없음'})` }; }
        report(`S3 실제 서버 390폭 ${f.name}: 요약·고치기·낡은 요약 제거·새 요약`, res.ok, res.note);
      }
      for (const w of [320, 390]) {
        let res;
        try { res = await runHandoff(browser, w); } catch (e) { res = { ok: false, note: `브라우저 단계 실패(${e instanceof Error ? e.message.split('\n')[0].slice(0, 80) : '알 수 없음'})` }; }
        report(`S3 실제 서버 ${w}폭 담당자 연결 모의 예시: 키보드 사례 전환·반복 선택, 안내 하나만, 모의 표시, 잘림 없음`, res.ok, res.note);
      }
    } catch (e) {
      report('S3 실제 서버 브라우저 시작', false, `실패(${e instanceof Error ? e.message.split('\n')[0].slice(0, 80) : '알 수 없음'})`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    const n = netAttempts();
    report('S3 서버의 외부 접속 시도 0건', n === 0, `차단 ${n}건`);
    await stopOrThrow('S3 서버 정리(종료 이벤트 확인)');
  }
} catch (e) {
  if (!(e instanceof Error && (e.message === 'not ready' || e.message === 'stop failed'))) report('검사 실행', false, '예외 발생(내용 비공개)');
} finally {
  clearTimeout(total);
  // 남은 서버가 있으면 같은 정리 경로로 종료. 종료 미확인이면 루트 정리 보류 + 실패(아래 every가 false)
  await finalCleanup({ manager, report, cleanupRoot: () => runRoot.cleanup() });
}
finish(results.every((x) => x.ok) ? 0 : 1, results.every((x) => x.ok) ? '통과' : '실패');
