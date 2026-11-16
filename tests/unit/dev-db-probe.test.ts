// PM 6918034030: 개발 DB 읽기 전용 프로브(scripts/probe/dev-db-readonly.mjs) — 주입한 가짜 드라이버 시험만.
// 실제 풀러·CA·D9·D10 통과 증거가 아니다. 실제 네트워크·DB·환경 파일을 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyError, connectionConfig, main, parseArgs, runProbe, SQL, validateTarget, PROBE_EXPECT } from '../../scripts/probe/dev-db-readonly.mjs';

const EXPECT = { host: 'db.fake-dev.example', port: 6543, database: 'postgres', user: 'app_server' };
const URL_OK = 'postgresql://app_server:FAKE-PASSWORD-MARK@db.fake-dev.example:6543/postgres';
const CA = '-----BEGIN CERTIFICATE-----\nFAKE-CA-MARK\n-----END CERTIFICATE-----';
const BAD_CA = '-----BEGIN CERTIFICATE-----\nBAD-CA-MARK\n-----END CERTIFICATE-----';
const MARKS = ['FAKE-PASSWORD-MARK', 'FAKE-CA-MARK', 'BAD-CA-MARK', 'db.fake-dev.example', 'SECRET-ERROR-MARK', 'postgresql://'];

type Q = { text: string };
function fakeDriver(o: { badCa?: 'reject' | 'connect' | 'dns' | 'refused' | 'timeout' | 'auth'; rows?: Partial<Record<string, unknown[]>>; failAt?: string; closeFails?: boolean; hang?: string } = {}) {
  const log = { connects: [] as Record<string, unknown>[], queries: [] as Q[], closes: 0 };
  const normal: Record<string, unknown[]> = {
    [SQL.whoami]: [{ u: 'app_server', v: '160004' }],
    [SQL.begin]: [], [SQL.setRole]: [], [SQL.setTimeout]: [], [SQL.rollback]: [],
    [SQL.inRole]: [{ u: 'app_staff', ro: 'on' }],
    [SQL.afterRole]: [{ u: 'app_server' }],
    [SQL.fnPriv]: [{ b: true }],
    [SQL.tablePriv]: [{ b: false }],
  };
  const connect = (cfg: Record<string, unknown>) => {
    log.connects.push(cfg);
    const ssl = cfg.ssl as { ca: string };
    if (ssl.ca === BAD_CA && o.badCa && o.badCa !== 'connect') {
      const code = { reject: 'SELF_SIGNED_CERT_IN_CHAIN', dns: 'ENOTFOUND', refused: 'ECONNREFUSED', timeout: 'ETIMEDOUT', auth: '28P01' }[o.badCa];
      throw Object.assign(new Error('SECRET-ERROR-MARK db.fake-dev.example'), { code, cause: new Error('FAKE-CA-MARK') });
    }
    return {
      query: (text: string) => {
        log.queries.push({ text });
        if (o.hang === text) return new Promise(() => {});
        if (o.failAt === text) return Promise.reject(Object.assign(new Error('SECRET-ERROR-MARK'), { code: '42501', query: text, parameters: ['FAKE-PASSWORD-MARK'] }));
        return Promise.resolve(o.rows?.[text] ?? normal[text]);
      },
      close: () => {
        log.closes++;
        return o.closeFails ? Promise.reject(new Error('close SECRET-ERROR-MARK')) : Promise.resolve();
      },
    };
  };
  return { connect, log };
}
const target = () => {
  const v = validateTarget(URL_OK, EXPECT);
  assert.ok(v.ok);
  return v.target;
};
const noMarks = (s: string, label: string) => { for (const m of MARKS) assert.ok(!s.includes(m), `${label}: ${m}`); };
const status = (r: { checks: { id: string; status: string; value?: unknown }[] }, id: string) => r.checks.find((c) => c.id === id);

test('B1 import·기본 실행은 닫힘: 도움말만, 기대값 미정이면 접속 0으로 EXPECT_UNSET', async () => {
  const src = readFileSync(new URL('../../scripts/probe/dev-db-readonly.mjs', import.meta.url), 'utf8');
  assert.ok(!/^import .*postgres/m.test(src), '드라이버는 실행 경로에서만 import');
  assert.ok(!/DATABASE_URL|dotenv|readFileSync/.test(src.replace(/\/\/.*$/gm, '')), 'DATABASE_URL·dotenv·파일 읽기 없음');
  assert.deepEqual(PROBE_EXPECT, { host: null, port: null, database: null, user: null }, '모르는 호스트를 만들지 않음');
  const out: string[] = [];
  let connects = 0;
  const connect = () => { connects++; throw new Error('should not connect'); };
  assert.equal(await main([], { FIDEON_PROBE_DB_URL: URL_OK, FIDEON_PROBE_DB_CA: CA }, { out: (s: string) => out.push(s), connect }), 0);
  assert.equal(await main(['--url-env', 'FIDEON_PROBE_DB_URL', '--ca-env', 'FIDEON_PROBE_DB_CA'], { FIDEON_PROBE_DB_URL: URL_OK, FIDEON_PROBE_DB_CA: CA }, { out: (s: string) => out.push(s), connect }), 0, '--run 없으면 실행 안 함');
  assert.equal(await main(['--run', '--url-env', 'FIDEON_PROBE_DB_URL', '--ca-env', 'FIDEON_PROBE_DB_CA'], { FIDEON_PROBE_DB_URL: URL_OK, FIDEON_PROBE_DB_CA: CA }, { out: (s: string) => out.push(s), connect }), 2);
  assert.ok(out.join('\n').includes('EXPECT_UNSET'));
  assert.equal(await main(['--run', '--url-env', 'DATABASE_URL', '--ca-env', 'FIDEON_PROBE_DB_CA'], { DATABASE_URL: URL_OK }, { out: (s: string) => out.push(s), connect, expect: EXPECT }), 2, '허용 이름 형식 밖 환경변수 거부');
  assert.equal(connects, 0);
  noMarks(out.join('\n'), 'B1 출력');
  assert.deepEqual(parseArgs(['--url-env', 'postgresql://x']).unknown.length, 1, 'CLI로 원문 URL 받지 않음');
});

test('B2 대상 검증(네트워크 전): 정확한 기대값만, 옵션·내부 주소·IP·포트·DB·역할 불일치 거부', () => {
  assert.equal(validateTarget(URL_OK, EXPECT).ok, true);
  const bad: [string, string][] = [
    ['http://app_server:p@db.fake-dev.example:6543/postgres', 'PROTOCOL'],
    [`${URL_OK}?sslmode=disable`, 'URL_OPTIONS'],
    [`${URL_OK}#x`, 'URL_OPTIONS'],
    ['postgresql://app_server:p@localhost:6543/postgres', 'HOST_FORBIDDEN'],
    ['postgresql://app_server:p@127.0.0.1:6543/postgres', 'HOST_FORBIDDEN'],
    ['postgresql://app_server:p@10.0.0.5:6543/postgres', 'HOST_FORBIDDEN'],
    ['postgresql://app_server:p@[::1]:6543/postgres', 'HOST_FORBIDDEN'],
    ['postgresql://app_server:p@db.svc.internal:6543/postgres', 'HOST_FORBIDDEN'],
    ['postgresql://app_server:p@other.example:6543/postgres', 'HOST_MISMATCH'],
    ['postgresql://app_server:p@db.fake-dev.example.evil.com:6543/postgres', 'HOST_MISMATCH'],
    ['postgresql://app_server:p@db.fake-dev.example:5432/postgres', 'PORT_MISMATCH'],
    ['postgresql://app_server:p@db.fake-dev.example:6543/fideon_test', 'DB_MISMATCH'],
    ['postgresql://postgres:p@db.fake-dev.example:6543/postgres', 'USER_MISMATCH'],
    ['postgresql://app_server@db.fake-dev.example:6543/postgres', 'PASSWORD_MISSING'],
    ['not a url', 'URL_INVALID'],
  ];
  for (const [u, code] of bad) assert.deepEqual(validateTarget(u, EXPECT), { ok: false, code }, u);
  assert.deepEqual(validateTarget(URL_OK), { ok: false, code: 'EXPECT_UNSET' });
});

test('B3 정상: TLS 옵션(CA·rejectUnauthorized·max1·prepare false), 고정 SQL만·쓰기 0, read-only·역할 전환·복귀·권한', async () => {
  const d = fakeDriver();
  const r = await runProbe({ connect: d.connect, target: target(), ca: CA, badCa: BAD_CA === BAD_CA ? null : null, expect: EXPECT });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  const cfg = d.log.connects[0];
  assert.deepEqual([cfg.max, cfg.prepare, (cfg.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, (cfg.ssl as { ca: string }).ca === CA], [1, false, true, true]);
  assert.deepEqual(connectionConfig(target(), CA).ssl, { ca: CA, rejectUnauthorized: true });
  const texts = d.log.queries.map((q) => q.text);
  assert.deepEqual(texts, [SQL.whoami, SQL.begin, SQL.setRole, SQL.setTimeout, SQL.inRole, SQL.rollback, SQL.afterRole, SQL.fnPriv, SQL.tablePriv]);
  for (const t of texts) assert.ok(!/\b(insert|update|delete|create|drop|alter|truncate|grant|revoke|copy)\b/i.test(t) && !/security\.|pii\./.test(t), t);
  assert.deepEqual(['D4_SET_LOCAL_ROLE', 'D5_READ_ONLY_TX', 'D6_ROLE_RESTORED', 'D7_STAFF_CAN_LIST', 'D8_NO_DIRECT_TABLE', 'D9_CLOSE'].map((id) => status(r, id)?.status), Array(6).fill('PASS'));
  assert.equal(status(r, 'D10_BAD_CA_REJECTED')?.status, 'NOT_RUN', '잘못된 CA 미제공은 미실행');
  assert.equal(d.log.closes, 1);
});

test('B4 잘못된 CA: 인증서 검증 오류만 통과, 연결 성공·DNS·거절·시간 초과·인증 실패는 실패(별도 연결)', async () => {
  const pass = fakeDriver({ badCa: 'reject' });
  const r = await runProbe({ connect: pass.connect, target: target(), ca: CA, badCa: BAD_CA, expect: EXPECT });
  assert.deepEqual(status(r, 'D10_BAD_CA_REJECTED'), { id: 'D10_BAD_CA_REJECTED', status: 'PASS', value: 'TLS_CA_REJECTED' });
  assert.equal(pass.log.connects.length, 2, '별도 연결');
  for (const [mode, cls] of [['connect', 'CONNECTED'], ['dns', 'DNS'], ['refused', 'CONNECT'], ['timeout', 'TIMEOUT'], ['auth', 'AUTH']] as const) {
    const d = fakeDriver({ badCa: mode });
    const x = await runProbe({ connect: d.connect, target: target(), ca: CA, badCa: BAD_CA, expect: EXPECT });
    assert.deepEqual(status(x, 'D10_BAD_CA_REJECTED'), { id: 'D10_BAD_CA_REJECTED', status: 'FAIL', value: cls }, mode);
    assert.equal(x.ok, false, mode);
  }
});

test('B5 장애·형식 오류·시간 초과·종료 실패: 실패로 닫고 연결 종료, 출력 허용 목록(원문 미반환)', async () => {
  const cases: [string, Parameters<typeof fakeDriver>[0], string][] = [
    ['권한 오류(쿼리 중)', { failAt: SQL.fnPriv }, 'D1x_PROBE_ERROR'],
    ['역할 미전환', { rows: { [SQL.inRole]: [{ u: 'app_server', ro: 'on' }] } }, 'D4_SET_LOCAL_ROLE'],
    ['read-only 아님', { rows: { [SQL.inRole]: [{ u: 'app_staff', ro: 'off' }] } }, 'D5_READ_ONLY_TX'],
    ['역할 미복귀', { rows: { [SQL.afterRole]: [{ u: 'app_staff' }] } }, 'D6_ROLE_RESTORED'],
    ['권한 형식 밖', { rows: { [SQL.fnPriv]: [{ b: 'SECRET-ERROR-MARK' }] } }, 'D7_STAFF_CAN_LIST'],
    ['테이블 직접 권한 있음', { rows: { [SQL.tablePriv]: [{ b: true }] } }, 'D8_NO_DIRECT_TABLE'],
    ['역할명 형식 밖', { rows: { [SQL.whoami]: [{ u: 'SECRET-ERROR-MARK x', v: 'abc' }] } }, 'D2_LOGIN_ROLE'],
    ['종료 실패', { closeFails: true }, 'D9_CLOSE'],
  ];
  for (const [label, o, id] of cases) {
    const d = fakeDriver(o);
    const r = await runProbe({ connect: d.connect, target: target(), ca: CA, badCa: null, expect: EXPECT });
    assert.equal(r.ok, false, label);
    assert.equal(r.checks.find((c) => c.id === id)?.status, 'FAIL', `${label}: ${JSON.stringify(r.checks)}`);
    assert.equal(d.log.closes, 1, `${label}: 연결 종료 시도`);
    noMarks(JSON.stringify(r.checks), label);
  }
  // 롤백은 역할 전환 실패에도 실행
  const rb = fakeDriver({ failAt: SQL.setRole });
  await runProbe({ connect: rb.connect, target: target(), ca: CA, badCa: null, expect: EXPECT });
  assert.ok(rb.log.queries.some((q) => q.text === SQL.rollback), '실패해도 rollback');
  // 시간 초과(가짜 sleep으로 즉시)
  const hang = fakeDriver({ hang: SQL.whoami });
  const t = await runProbe({ connect: hang.connect, target: target(), ca: CA, badCa: null, expect: EXPECT, timeoutMs: 5, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) });
  assert.deepEqual(status(t, 'D1_CONNECT_TLS'), { id: 'D1_CONNECT_TLS', status: 'FAIL', value: 'TIMEOUT' }, '첫 문장 응답 없음 = 연결 단계 시간 초과');
  assert.equal(hang.log.closes, 1);
  assert.equal(classifyError({ code: 'WHATEVER', message: 'SECRET-ERROR-MARK' }), 'OTHER');
});

test('B6 main 실행 경로(가짜 드라이버·기대값 주입): 출력은 고정 ID·상태·허용 값만', async () => {
  const d = fakeDriver({ badCa: 'reject' });
  const out: string[] = [];
  const code = await main(['--run', '--url-env', 'FIDEON_PROBE_DB_URL', '--ca-env', 'FIDEON_PROBE_DB_CA', '--bad-ca-env', 'FIDEON_PROBE_BAD_CA'],
    { FIDEON_PROBE_DB_URL: URL_OK, FIDEON_PROBE_DB_CA: CA, FIDEON_PROBE_BAD_CA: BAD_CA }, { out: (s: string) => out.push(s), connect: d.connect, expect: EXPECT });
  assert.equal(code, 0);
  const text = out.join('\n');
  noMarks(text, 'main 출력');
  for (const line of text.split('\n')) assert.match(line, /^(PASS|FAIL|NOT_RUN) \| D\d+x?_[A-Z_]+( \| (app_server|app_staff|\d{5,6}|true|false|TLS_CA_REJECTED))?$/, line);
  const noCa = await main(['--run', '--url-env', 'FIDEON_PROBE_DB_URL', '--ca-env', 'FIDEON_PROBE_DB_CA'], { FIDEON_PROBE_DB_URL: URL_OK }, { out: () => {}, connect: d.connect, expect: EXPECT });
  assert.equal(noCa, 2, 'CA 없으면 접속 전 중단');
});
