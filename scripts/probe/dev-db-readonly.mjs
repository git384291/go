#!/usr/bin/env node
// 개발 DB(fideon-dev) 풀러·CA 수동 읽기 전용 연결 프로브 (PM 6918034030, 계약: docs/design/DEV-AUTH-CONNECTION-PLAN.md 단계 D).
// **실제 네트워크 실행은 승인 전이다.** CI·자동 명령에 연결하지 않는다. 시험은 주입한 가짜 드라이버로만 한다.
//
// 닫힌 기본값
// - import만으로는 접속·dotenv·환경값 읽기를 하지 않는다(드라이버도 실행 경로에서만 불러온다).
// - 인자 없이 실행하면 도움말만 출력하고 끝난다. `--run` + `--url-env <이름>` + `--ca-env <이름>`가 모두 있어야 실행 경로에 들어간다.
//   값은 지정한 환경변수 이름에서만 읽는다(DATABASE_URL·.env 파일 자동 읽기 없음, CLI 인자로 원문을 받지 않음).
// - 대상은 사전에 정한 기대값(PROBE_EXPECT: 정확한 호스트·포트·DB·로그인 역할)과 정확히 같아야 한다.
//   현재 기대값은 모두 미정(null)이므로 실행 경로에서도 접속 전에 EXPECT_UNSET으로 닫힌다. 실제 값은 프로젝트 설정 확인 뒤 별도 승인으로 정한다.
// 출력: 고정 검사 ID·상태·허용 값(역할 이름·버전 숫자·boolean)만. 오류 원문·URL·호스트·인증서·키는 출력하지 않는다.
import { pathToFileURL } from 'node:url';

/**
 * loginUser: 풀러 접속 username(예: 프로젝트 suffix가 붙은 이름). dbRole: 접속 뒤 DB의 current_user(예: app_server). 둘을 따로 대조한다.
 * @typedef {{ host: string | null, port: number | null, database: string | null, loginUser: string | null, dbRole: string | null }} ProbeExpect
 */
/** @type {Readonly<ProbeExpect>} */
export const PROBE_EXPECT = Object.freeze({ host: null, port: null, database: null, loginUser: null, dbRole: null });
/** 출력에 실을 수 있는 역할 이름(고정 허용 목록). 그 밖의 값은 'invalid'로만 표시 */
export const OUTPUT_ROLES = Object.freeze(['app_server', 'app_staff']);
export const ENV_NAME_RE = /^FIDEON_PROBE_[A-Z0-9_]{1,40}$/;

/** 고정 SQL 허용 목록. 이 밖의 문장은 실행하지 않는다(모두 읽기·세션 설정·트랜잭션 제어) */
export const SQL = Object.freeze({
  whoami: "select current_user::text as u, current_setting('server_version_num') as v",
  begin: 'begin read only',
  setRole: 'set local role app_staff',
  setTimeout: "set local statement_timeout = '5s'",
  inRole: "select current_user::text as u, current_setting('transaction_read_only') as ro",
  rollback: 'rollback',
  afterRole: 'select current_user::text as u',
  fnPriv: "select has_function_privilege('app_staff', 'api.list_leads(uuid,uuid,text,integer,integer)', 'execute') as b",
  tablePriv: "select has_table_privilege(current_user, 'core.leads', 'select') as b",
});
const ALLOWED_SQL = new Set(Object.values(SQL));

export function parseArgs(argv) {
  const out = { run: false, urlEnv: null, caEnv: null, badCaEnv: null, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = true;
    else if (a === '--url-env' || a === '--ca-env' || a === '--bad-ca-env') {
      const v = argv[i + 1];
      i++;
      if (typeof v !== 'string' || !ENV_NAME_RE.test(v)) { out.unknown.push(a); continue; }
      if (a === '--url-env') out.urlEnv = v;
      else if (a === '--ca-env') out.caEnv = v;
      else out.badCaEnv = v;
    } else out.unknown.push('arg'); // 원문을 남기지 않는다
  }
  return out;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const INTERNAL_SUFFIX = /(\.local|\.internal|\.localhost|\.lan|\.home|\.corp)$/i;

/** 네트워크 호출 전 대상 검증. 기대값과 정확히 같은 호스트·포트·DB·역할만 */
/** @param {unknown} rawUrl @param {Readonly<ProbeExpect>} [expect] */
export function validateTarget(rawUrl, expect = PROBE_EXPECT) {
  if (!expect || !expect.host || !expect.database || !expect.loginUser || !expect.dbRole || !expect.port) return { ok: false, code: 'EXPECT_UNSET' };
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 1024) return { ok: false, code: 'URL_MISSING' };
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, code: 'URL_INVALID' }; }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return { ok: false, code: 'PROTOCOL' };
  if (u.search !== '' || u.hash !== '') return { ok: false, code: 'URL_OPTIONS' }; // sslmode 등 연결 옵션 주입 금지
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || IPV4.test(host) || host.startsWith('[') || host.includes(':') || INTERNAL_SUFFIX.test(host)) return { ok: false, code: 'HOST_FORBIDDEN' };
  if (host !== String(expect.host).toLowerCase()) return { ok: false, code: 'HOST_MISMATCH' };
  const port = u.port === '' ? 5432 : Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: 'PORT_INVALID' };
  if (port !== expect.port) return { ok: false, code: 'PORT_MISMATCH' };
  let database, user, password;
  try {
    database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  } catch {
    return { ok: false, code: 'URL_ENCODING' }; // 잘못된 퍼센트 인코딩: 예외 없이 고정 거부
  }
  if (database !== expect.database) return { ok: false, code: 'DB_MISMATCH' };
  if (user !== expect.loginUser) return { ok: false, code: 'USER_MISMATCH' };
  if (!password) return { ok: false, code: 'PASSWORD_MISSING' };
  return { ok: true, target: { host, port, database, user, password } };
}

/** 드라이버 설정(전역 db()·withRole과 별개의 전용 연결). TLS 검증은 끌 수 없다 */
export function connectionConfig(target, ca) {
  return {
    host: target.host, port: target.port, database: target.database, username: target.user, password: target.password,
    ssl: { ca, rejectUnauthorized: true }, max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5,
  };
}

const CA_REJECT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED',
]);
/** 오류를 고정 분류로만 바꾼다(message·query·cause 미사용) */
export function classifyError(e) {
  const code = e && typeof e === 'object' && typeof e.code === 'string' ? e.code : '';
  if (CA_REJECT_CODES.has(code)) return 'TLS_CA_REJECTED';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') return 'CONNECT';
  if (code === 'ETIMEDOUT' || code === 'CONNECT_TIMEOUT' || code === 'PROBE_TIMEOUT') return 'TIMEOUT';
  if (code === '28P01' || code === '28000') return 'AUTH';
  if (code === '42501') return 'PERMISSION';
  return 'OTHER';
}

const isBool = (v) => typeof v === 'boolean';
const roleOut = (u) => (typeof u === 'string' && OUTPUT_ROLES.includes(u) ? u : 'invalid');
const timeoutError = () => Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' });

/**
 * 프로브 본체. connect(config) → client 또는 Promise<client>. client = { query(text): Promise<rows>, close(): Promise<void> }
 * - 실행 단계 전체(정상 연결 + 잘못된 CA 연결)는 **하나의 절대 마감 시각**(now()+timeoutMs) 안에서만 진행한다.
 *   마감이 지나면 다음 SQL·연결을 시작하지 않는다. 대기 타이머는 끝나면 해제한다.
 * - 정리(close)는 별도의 짧은 한도(cleanupMs)로 한다. 마감 뒤 늦게 도착한 자기 client도 그 한도 안에서 닫고, 확인 못 하면 FAIL.
 * 결과: { ok(실행한 검사 전부 PASS), complete(미실행 없음), checks: [{ id, status: 'PASS'|'FAIL'|'NOT_RUN', value? }] }
 * @param {{ connect: (cfg: Record<string, unknown>) => any, target: any, ca: string, badCa?: string | null,
 *           expect?: Readonly<ProbeExpect>, timeoutMs?: number, cleanupMs?: number, now?: () => number,
 *           timers?: { set: (fn: () => void, ms: number) => any, clear: (h: any) => void } }} opts
 */
export async function runProbe({ connect, target, ca, badCa, expect = PROBE_EXPECT, timeoutMs = 30_000, cleanupMs = 5_000, now = () => Date.now(), timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) } }) {
  const checks = [];
  const add = (id, pass, value) => checks.push(value === undefined ? { id, status: pass ? 'PASS' : 'FAIL' } : { id, status: pass ? 'PASS' : 'FAIL', value });
  const deadline = now() + timeoutMs;
  // 마감 타이머가 한 번이라도 울리면 이후는 마감 지남으로 본다(타이머와 시계의 1ms 차이로 새 작업이 시작되지 않게)
  let expired = false;
  const left = () => (expired ? 0 : deadline - now());
  /** p를 ms 안에 끝내지 못하면 PROBE_TIMEOUT. 타이머는 항상 해제 */
  const within = (p, ms) => new Promise((resolve, reject) => {
    if (ms <= 0) { reject(timeoutError()); return; }
    const h = timers.set(() => reject(timeoutError()), ms);
    Promise.resolve(p).then((v) => { timers.clear(h); resolve(v); }, (e) => { timers.clear(h); reject(e); });
  });
  const beforeDeadline = (p) => within(p, left()).catch((e) => { if (e && e.code === 'PROBE_TIMEOUT') expired = true; throw e; });
  const run = async (client, text) => {
    if (!ALLOWED_SQL.has(text)) throw Object.assign(new Error('sql not allowed'), { code: 'SQL_NOT_ALLOWED' });
    if (left() <= 0) throw timeoutError(); // 마감 뒤 새 SQL 시작 안 함
    const rows = await beforeDeadline(client.query(text));
    if (!Array.isArray(rows)) throw Object.assign(new Error('bad rows'), { code: 'BAD_RESULT' });
    return rows;
  };
  /** 연결 시작: 마감 전일 때만. 늦게 도착해도 소유권을 잃지 않도록 원래 Promise를 돌려준다 */
  const startConnect = (cfg) => {
    if (left() <= 0) return null;
    try { return Promise.resolve(connect(cfg)); } catch (e) { return Promise.reject(e); }
  };
  /** 자기 연결 정리(별도 짧은 한도). 늦게 생긴 client도 기다렸다가 닫는다. 확인 못 하면 false */
  const closeOwned = async (pending, client) => {
    let c = client;
    if (!c && pending) {
      try { c = await within(pending, cleanupMs); } catch (e) {
        if (e && e.code === 'PROBE_TIMEOUT') {
          pending.then((late) => late && late.close && Promise.resolve(late.close()).catch(() => {}), () => {});
          return false; // 연결 여부 미확인: 정리 성공으로 기록하지 않음(늦게 오면 그때 닫는다)
        }
        return null; // 연결 자체가 실패: 정리할 자기 client 없음
      }
    }
    if (!c) return null;
    try { await within(Promise.resolve(c.close()), cleanupMs); return true; } catch { return false; }
  };

  // 1) 정상 CA 연결
  let client = null;
  let pending = null;
  try {
    pending = startConnect(connectionConfig(target, ca));
    if (!pending) throw timeoutError();
    client = await beforeDeadline(pending);
    const w = (await run(client, SQL.whoami))[0] ?? {};
    const vOk = typeof w.v === 'string' && /^\d{5,6}$/.test(w.v);
    add('D1_CONNECT_TLS', true);
    add('D2_DB_ROLE', w.u === expect.dbRole, roleOut(w.u));
    add('D3_SERVER_VERSION', vOk, vOk ? w.v : 'invalid');
    await run(client, SQL.begin);
    try {
      await run(client, SQL.setRole);
      await run(client, SQL.setTimeout);
      const r = (await run(client, SQL.inRole))[0] ?? {};
      add('D4_SET_LOCAL_ROLE', r.u === 'app_staff', roleOut(r.u));
      add('D5_READ_ONLY_TX', r.ro === 'on');
    } finally {
      try { await run(client, SQL.rollback); } catch (e) { add('D5x_ROLLBACK', false, classifyError(e)); }
    }
    const a = (await run(client, SQL.afterRole))[0] ?? {};
    add('D6_ROLE_RESTORED', a.u === expect.dbRole, roleOut(a.u));
    const f = (await run(client, SQL.fnPriv))[0] ?? {};
    add('D7_STAFF_CAN_LIST', f.b === true, isBool(f.b) ? f.b : 'invalid');
    const t = (await run(client, SQL.tablePriv))[0] ?? {};
    add('D8_NO_DIRECT_TABLE', t.b === false, isBool(t.b) ? t.b : 'invalid');
  } catch (e) {
    // 연결 단계 실패면 D1 실패, 그 뒤 단계 실패면 별도 오류 행(분류 코드만)
    if (!checks.some((c) => c.id === 'D1_CONNECT_TLS')) add('D1_CONNECT_TLS', false, classifyError(e));
    else add('D1x_PROBE_ERROR', false, classifyError(e));
  } finally {
    const closed = await closeOwned(pending, client);
    if (closed !== null) add('D9_CLOSE', closed);
  }

  // 2) 잘못된 CA 음성 시험(별도 연결, 같은 마감 안). 인증서 검증 오류만 통과, 그 밖의 오류·성공은 실패
  if (!badCa) {
    checks.push({ id: 'D10_BAD_CA_REJECTED', status: 'NOT_RUN' }); // 미실행: CA 거부 통과로 세지 않음
  } else {
    let bad = null;
    let badPending = null;
    try {
      badPending = startConnect(connectionConfig(target, badCa));
      if (!badPending) throw timeoutError();
      bad = await beforeDeadline(badPending);
      await run(bad, SQL.whoami);
      add('D10_BAD_CA_REJECTED', false, 'CONNECTED');
    } catch (e) {
      const c = classifyError(e);
      add('D10_BAD_CA_REJECTED', c === 'TLS_CA_REJECTED', c);
    } finally {
      const closed = await closeOwned(badPending, bad);
      if (closed === false) add('D11_BAD_CA_CLOSE', false);
    }
  }
  const ok = checks.every((c) => c.status !== 'FAIL');
  const complete = checks.every((c) => c.status !== 'NOT_RUN');
  return { ok, complete, checks };
}

export function formatChecks(checks) {
  return checks.map((c) => `${c.status} | ${c.id}${c.value === undefined ? '' : ` | ${c.value}`}`).join('\n');
}

const HELP = `개발 DB 읽기 전용 연결 프로브(수동, 승인 전 미실행)
사용: node scripts/probe/dev-db-readonly.mjs --run --url-env FIDEON_PROBE_DB_URL --ca-env FIDEON_PROBE_DB_CA [--bad-ca-env FIDEON_PROBE_BAD_CA]
- 값은 지정한 환경변수에서만 읽습니다. 인자 없이 실행하면 아무 것도 하지 않습니다.
- 기대 대상(PROBE_EXPECT)이 정해지기 전에는 접속하지 않고 EXPECT_UNSET으로 끝납니다.`;

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ out?: (s: string) => void, connect?: (cfg: Record<string, unknown>) => any, expect?: Readonly<ProbeExpect> }} [deps]
 */
export async function main(argv, env, deps = {}) {
  const a = parseArgs(argv);
  const out = deps.out ?? ((s) => process.stdout.write(s + '\n'));
  if (!a.run || !a.urlEnv || !a.caEnv || a.unknown.length) {
    out(HELP);
    return a.run ? 2 : 0;
  }
  const v = validateTarget(env[a.urlEnv], deps.expect ?? PROBE_EXPECT);
  if (!v.ok) { out(`FAIL | D0_TARGET | ${v.code}`); return 2; }
  const ca = env[a.caEnv];
  if (typeof ca !== 'string' || !ca.includes('BEGIN CERTIFICATE')) { out('FAIL | D0_CA | CA_MISSING'); return 2; }
  const badCa = a.badCaEnv ? env[a.badCaEnv] : null;
  let connect = deps.connect;
  if (!connect) {
    const { default: postgres } = await import('postgres'); // 실행 경로에서만 드라이버를 불러온다
    connect = (cfg) => {
      const sql = postgres({ ...cfg, onnotice: () => {} });
      return { query: (text) => sql.unsafe(text), close: () => sql.end({ timeout: 5 }) };
    };
  }
  const r = await runProbe({ connect, target: v.target, ca, badCa, expect: deps.expect ?? PROBE_EXPECT });
  out(formatChecks(r.checks));
  if (!r.ok) return 1;
  return r.complete ? 0 : 3; // 3: 실행한 검사는 통과했지만 잘못된 CA 음성 시험이 미실행(전체 통과 아님)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code), () => { process.stdout.write('FAIL | D0_PROBE | OTHER\n'); process.exit(1); });
}
