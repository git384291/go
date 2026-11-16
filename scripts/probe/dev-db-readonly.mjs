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

/** @typedef {{ host: string | null, port: number | null, database: string | null, user: string | null }} ProbeExpect */
/** @type {Readonly<ProbeExpect>} */
export const PROBE_EXPECT = Object.freeze({ host: null, port: null, database: null, user: null });
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
  if (!expect || !expect.host || !expect.database || !expect.user || !expect.port) return { ok: false, code: 'EXPECT_UNSET' };
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
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (database !== expect.database) return { ok: false, code: 'DB_MISMATCH' };
  const user = decodeURIComponent(u.username);
  if (user !== expect.user) return { ok: false, code: 'USER_MISMATCH' };
  const password = decodeURIComponent(u.password);
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
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * 프로브 본체. deps.connect(config) → { query(text): Promise<rows>, close(): Promise<void> }
 * 결과: { ok, checks: [{ id, status: 'PASS'|'FAIL'|'NOT_RUN', value? }] } — value는 허용 형식만
 */
/**
 * @param {{ connect: (cfg: Record<string, unknown>) => any, target: any, ca: string, badCa?: string | null,
 *           expect?: Readonly<ProbeExpect>, timeoutMs?: number, sleep?: (ms: number) => Promise<unknown> }} opts
 */
export async function runProbe({ connect, target, ca, badCa, expect = PROBE_EXPECT, timeoutMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const checks = [];
  const add = (id, pass, value) => checks.push(value === undefined ? { id, status: pass ? 'PASS' : 'FAIL' } : { id, status: pass ? 'PASS' : 'FAIL', value });
  const withTimeout = (p) => Promise.race([p, sleep(timeoutMs).then(() => { throw Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' }); })]);
  const run = async (client, text) => {
    if (!ALLOWED_SQL.has(text)) throw Object.assign(new Error('sql not allowed'), { code: 'SQL_NOT_ALLOWED' });
    const rows = await withTimeout(client.query(text));
    if (!Array.isArray(rows)) throw Object.assign(new Error('bad rows'), { code: 'BAD_RESULT' });
    return rows;
  };

  // 1) 정상 CA 연결
  let client = null;
  try {
    client = await withTimeout(Promise.resolve(connect(connectionConfig(target, ca))));
    const w = (await run(client, SQL.whoami))[0] ?? {};
    const vOk = typeof w.v === 'string' && /^\d{5,6}$/.test(w.v);
    add('D1_CONNECT_TLS', true);
    add('D2_LOGIN_ROLE', w.u === expect.user, typeof w.u === 'string' && ROLE_RE.test(w.u) ? w.u : 'invalid');
    add('D3_SERVER_VERSION', vOk, vOk ? w.v : 'invalid');
    await run(client, SQL.begin);
    try {
      await run(client, SQL.setRole);
      await run(client, SQL.setTimeout);
      const r = (await run(client, SQL.inRole))[0] ?? {};
      add('D4_SET_LOCAL_ROLE', r.u === 'app_staff', typeof r.u === 'string' && ROLE_RE.test(r.u) ? r.u : 'invalid');
      add('D5_READ_ONLY_TX', r.ro === 'on');
    } finally {
      await run(client, SQL.rollback);
    }
    const a = (await run(client, SQL.afterRole))[0] ?? {};
    add('D6_ROLE_RESTORED', a.u === expect.user, typeof a.u === 'string' && ROLE_RE.test(a.u) ? a.u : 'invalid');
    const f = (await run(client, SQL.fnPriv))[0] ?? {};
    add('D7_STAFF_CAN_LIST', f.b === true, isBool(f.b) ? f.b : 'invalid');
    const t = (await run(client, SQL.tablePriv))[0] ?? {};
    add('D8_NO_DIRECT_TABLE', t.b === false, isBool(t.b) ? t.b : 'invalid');
  } catch (e) {
    // 연결 단계 실패면 D1 실패, 그 뒤 단계 실패면 별도 오류 행(분류 코드만)
    if (!checks.some((c) => c.id === 'D1_CONNECT_TLS')) add('D1_CONNECT_TLS', false, classifyError(e));
    else add('D1x_PROBE_ERROR', false, classifyError(e));
  } finally {
    if (client) {
      try { await withTimeout(Promise.resolve(client.close())); add('D9_CLOSE', true); } catch { add('D9_CLOSE', false); }
    }
  }

  // 2) 잘못된 CA 음성 시험(별도 연결). 인증서 검증 오류만 통과, 그 밖의 오류·성공은 실패
  if (!badCa) {
    checks.push({ id: 'D10_BAD_CA_REJECTED', status: 'NOT_RUN' });
  } else {
    let bad = null;
    try {
      bad = await withTimeout(Promise.resolve(connect(connectionConfig(target, badCa))));
      await run(bad, SQL.whoami);
      add('D10_BAD_CA_REJECTED', false, 'CONNECTED');
    } catch (e) {
      const c = classifyError(e);
      add('D10_BAD_CA_REJECTED', c === 'TLS_CA_REJECTED', c);
    } finally {
      if (bad) {
        try { await withTimeout(Promise.resolve(bad.close())); } catch { add('D11_BAD_CA_CLOSE', false); }
      }
    }
  }
  const ok = checks.every((c) => c.status === 'PASS' || c.id === 'D10_BAD_CA_REJECTED' && c.status === 'NOT_RUN');
  return { ok, checks };
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
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code), () => { process.stdout.write('FAIL | D0_PROBE | OTHER\n'); process.exit(1); });
}
