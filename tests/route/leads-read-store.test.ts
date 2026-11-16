// PM 6908711385: 비활성 마스킹 목록 어댑터(leadsReadStore) 시험.
// 고정 가상 직원·행·가짜 트랜잭션 실행기만 쓴다. 실제 PostgreSQL·RLS·풀러·Auth 시험이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { listMaskedLeads, type LeadsReadDeps, type SqlTag } from '../../src/server/admin/leadsReadStore';
import type { StaffIdentity } from '../../src/server/auth/staffSession';
import { maskName } from '../../src/server/security/piiCrypto';

const OWNER = '00000000-0000-4000-8000-000000000001';
const COUNSELOR = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const SESSION = '00000000-0000-4000-8000-0000000000aa';
const who = (role: string, actor = OWNER): StaffIdentity => ({ actor, session: SESSION, token: 'test-only-signed-token', role } as StaffIdentity);

const SECRET_MARKS = ['RAW-PHONE-01012345678', 'ENC:v1:secret', 'HMAC-deadbeef', '서울시 비밀구', 'memo-secret', 'contact-free-text', 'utm-free-text'];
function row(over: Record<string, unknown> = {}) {
  return {
    lead_id: '10000000-0000-4000-8000-000000000001',
    created_at: new Date('2026-11-16T01:02:03.000Z'),
    name_masked: '홍*동',
    phone_masked: '010-****-1234',
    interest: 'internet_tv',
    status: 'new',
    assigned_to: null,
    // 어댑터가 버려야 하는 숨김 필드(가짜 표식)
    contact_time: 'contact-free-text',
    utm_source: 'utm-free-text',
    phone_enc: 'ENC:v1:secret',
    phone_hmac: 'HMAC-deadbeef',
    phone_raw: 'RAW-PHONE-01012345678',
    address: '서울시 비밀구',
    notes: 'memo-secret',
    ...over,
  };
}

type Call = { sql: string; values: unknown[] };
function fakeDeps(opts: { enabled?: boolean; rows?: unknown; error?: unknown } = {}) {
  const hasError = 'error' in opts;
  const rowsValue = 'rows' in opts ? opts.rows : [];
  const calls: Call[] = [];
  let runs = 0;
  const deps: LeadsReadDeps = {
    enabled: () => opts.enabled ?? true,
    runInTransaction: async (fn) => {
      runs++;
      const tx: SqlTag = (strings, ...values) => {
        calls.push({ sql: strings.join('$?'), values });
        if (hasError) return Promise.reject(opts.error);
        return Promise.resolve(rowsValue as readonly unknown[]);
      };
      return fn(tx);
    },
  };
  return { deps, calls, runs: () => runs };
}

const assertNoSecrets = (v: unknown, label: string) => {
  const s = JSON.stringify(v);
  for (const m of SECRET_MARKS) assert.ok(!s.includes(m), `${label}: ${m}`);
  for (const k of ['contact', 'utm', 'enc', 'hmac', 'address', 'notes', 'token', 'session']) assert.ok(!new RegExp(`"[^"]*${k}[^"]*":`, 'i').test(s), `${label}: key ${k} in ${s}`);
};

test('L1 비활성·역할 거부·형태 오류 컨텍스트는 실행기 0회', async () => {
  const off = fakeDeps({ enabled: false, rows: [row()] });
  assert.deepEqual(await listMaskedLeads(off.deps, who('owner')), { ok: false, code: 'DISABLED' });
  assert.equal(off.runs(), 0);
  const throwing = fakeDeps();
  throwing.deps.enabled = () => {
    throw new Error('x');
  };
  assert.deepEqual(await listMaskedLeads(throwing.deps, who('owner')), { ok: false, code: 'DISABLED' });
  for (const id of [who('reviewer'), who('policy_editor'), who('admin'), who('OWNER'), { ...who('owner'), actor: 'not-uuid' }, { ...who('owner'), session: '' }, { ...who('owner'), token: '' }, null, undefined, 'owner'] as unknown[]) {
    const f = fakeDeps({ rows: [row()] });
    const r = await listMaskedLeads(f.deps, id as StaffIdentity);
    assert.deepEqual(r, { ok: false, code: 'FORBIDDEN' }, JSON.stringify(id));
    assert.equal(f.runs(), 0, JSON.stringify(id));
  }
});

test('L2 페이지 인자: 정수·범위 검증, 잘못되면 실행기 0회. 값은 바인딩 파라미터로만 전달', async () => {
  for (const page of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '10' }, { offset: -1 }, { offset: 100001 }, { limit: NaN }, [], null, 'limit=10']) {
    const f = fakeDeps();
    assert.deepEqual(await listMaskedLeads(f.deps, who('owner'), page), { ok: false, code: 'INVALID_PAGE' }, JSON.stringify(page));
    assert.equal(f.runs(), 0);
  }
  const f = fakeDeps({ rows: [] });
  const r = await listMaskedLeads(f.deps, who('owner'), { limit: 20, offset: 40 });
  assert.deepEqual(r, { ok: true, items: [] });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].values, [OWNER, SESSION, 'test-only-signed-token', 20, 40]);
  assert.match(f.calls[0].sql, /from api\.list_leads\(/);
  assert.ok(!/contact_time|utm_source|reveal_contact/.test(f.calls[0].sql), 'SQL이 자유 입력 열·열람 함수를 고르지 않음');
  assert.ok(!f.calls[0].sql.includes('test-only-signed-token') && !f.calls[0].sql.includes(OWNER), '값이 SQL 문자열에 섞이지 않음');
  const d = fakeDeps({ rows: [] });
  await listMaskedLeads(d.deps, who('owner'));
  assert.deepEqual(d.calls[0].values.slice(3), [50, 0], '기본 페이지');
});

test('L3 owner: 전체(미배정 포함)를 허용 목록 마스킹 DTO로, 숨김 필드 미포함, 원본 행 불변', async () => {
  const rows = [row(), row({ lead_id: '10000000-0000-4000-8000-000000000002', assigned_to: COUNSELOR, status: 'contacting', created_at: '2026-11-16T09:00:00+09:00', name_masked: '김*' })];
  const before = JSON.stringify(rows);
  const f = fakeDeps({ rows });
  const r = await listMaskedLeads(f.deps, who('owner'));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.items.length, 2);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['assignedTo', 'createdAt', 'id', 'interest', 'nameMasked', 'phoneMasked', 'status']);
  assert.deepEqual(r.items[0], { id: rows[0].lead_id, createdAt: '2026-11-16T01:02:03.000Z', nameMasked: '홍*동', phoneMasked: '010-****-1234', interest: 'internet_tv', status: 'new', assignedTo: null });
  assert.equal(r.items[1].createdAt, '2026-11-16T00:00:00.000Z');
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.items) && Object.isFrozen(r.items[0]));
  assertNoSecrets(r, 'owner DTO');
  assert.equal(JSON.stringify(rows), before, '원본 행 불변');
  assert.ok(r.items[0] !== (rows[0] as unknown), '새 객체');
});

test('L4 counselor: 본인 배정만 성공. 다른 직원·미배정 행이 섞이면 누락이 아니라 전체 실패', async () => {
  const mine = row({ assigned_to: COUNSELOR });
  const ok = fakeDeps({ rows: [mine] });
  const r = await listMaskedLeads(ok.deps, who('counselor', COUNSELOR));
  assert.equal(r.ok, true);
  for (const bad of [row({ assigned_to: OTHER }), row({ assigned_to: null })]) {
    const f = fakeDeps({ rows: [mine, bad] });
    assert.deepEqual(await listMaskedLeads(f.deps, who('counselor', COUNSELOR)), { ok: false, code: 'SCOPE_VIOLATION' });
  }
});

test('L5 잘못된 runtime 행은 안전한 전체 실패(INVALID_DATA), 오류에 행 값 미포함', async () => {
  const bads: [string, unknown][] = [
    ['null 행', null],
    ['배열 행', []],
    ['ID 비UUID', row({ lead_id: 'abc' })],
    ['ID 대문자 UUID', row({ lead_id: '10000000-0000-4000-8000-00000000000A' })],
    ['날짜 무효', row({ created_at: new Date('x') })],
    ['날짜 문자열 형식 밖', row({ created_at: '어제' })],
    ['날짜 null', row({ created_at: null })],
    ['이름 원문(* 없음)', row({ name_masked: '홍길동' })],
    ['이름 숫자', row({ name_masked: '홍*1' })],
    ['이름 과다 길이', row({ name_masked: '가*'.repeat(11) })],
    ['번호 원문', row({ phone_masked: 'RAW-PHONE-01012345678' })],
    ['번호 원문 숫자', row({ phone_masked: '010-1234-5678' })],
    ['번호 형식 밖', row({ phone_masked: '011-****-1234' })],
    ['예약 상품', row({ interest: 'cctv_security' })],
    ['미정의 상품', row({ interest: 'mobile' })],
    ['상태 미정의', row({ status: 'deleted' })],
    ['배정 비UUID', row({ assigned_to: 'someone' })],
  ];
  for (const [label, bad] of bads) {
    const f = fakeDeps({ rows: [row(), bad] });
    const r = await listMaskedLeads(f.deps, who('owner'));
    assert.deepEqual(r, { ok: false, code: 'INVALID_DATA' }, label);
    assertNoSecrets(r, label);
  }
  for (const rows of [null, 'rows', { length: 1 }]) {
    const f = fakeDeps({ rows });
    assert.deepEqual(await listMaskedLeads(f.deps, who('owner')), { ok: false, code: 'INVALID_DATA' }, JSON.stringify(rows));
  }
  const many = fakeDeps({ rows: [row(), row()] });
  assert.deepEqual(await listMaskedLeads(many.deps, who('owner'), { limit: 1 }), { ok: false, code: 'INVALID_DATA' }, 'limit보다 많은 행');
});

test('L6 DB 오류: 권한 거부 42501 → FORBIDDEN, 그 밖 → UNAVAILABLE. 빈 목록 성공으로 감추지 않고 원문 미포함', async () => {
  const pgErr = Object.assign(new Error('permission denied for function list_leads; query select ... RAW-PHONE-01012345678'), {
    code: '42501', query: 'select secret', parameters: ['test-only-signed-token'], cause: new Error('ENC:v1:secret'),
  });
  const r1 = await listMaskedLeads(fakeDeps({ error: pgErr }).deps, who('owner'));
  assert.deepEqual(r1, { ok: false, code: 'FORBIDDEN' });
  for (const err of [new Error('connect ECONNREFUSED 127.0.0.1:5432 RAW-PHONE-01012345678'), Object.assign(new Error('x'), { code: '57P01' }), 'string error', null]) {
    const r = await listMaskedLeads(fakeDeps({ error: err }).deps, who('owner'));
    assert.deepEqual(r, { ok: false, code: 'UNAVAILABLE' });
    assertNoSecrets(r, String(err));
  }
  // 실행기 자체가 실패해도(트랜잭션 시작 실패) 같은 처리
  const deps: LeadsReadDeps = { enabled: () => true, runInTransaction: () => Promise.reject(new Error('pool exhausted')) };
  assert.deepEqual(await listMaskedLeads(deps, who('owner')), { ok: false, code: 'UNAVAILABLE' });
});

test('L7 실제 API·페이지·클라이언트 코드는 새 어댑터를 import하지 않음, 어댑터는 환경값·기본 실행기를 읽지 않음', () => {
  const root = path.resolve(__dirname, '../../src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(root);
  // 미배선 HTTP 조합 모듈(leadsReadApi.ts)만 타입을 가져간다. 그 모듈의 미연결은 leads-read-api.test.ts A6이 확인한다
  // 허용된 import: HTTP 조합(leadsReadApi.ts)·출처 분기(leadsRoute.ts)·목록 route(app/api/admin/leads/route.ts, PM 6913462268)
  const allowed = [/server[\\/]admin[\\/]leadsRead(Store|Api)\.ts$/, /server[\\/]admin[\\/]leadsRoute\.ts$/, /app[\\/]api[\\/]admin[\\/]leads[\\/]route\.ts$/];
  const importers = files.filter((f) => !allowed.some((re) => re.test(f)) && /leadsReadStore/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(importers, [], '배선은 별도 승인 범위');
  const src = readFileSync(path.join(root, 'server/admin/leadsReadStore.ts'), 'utf8');
  assert.ok(!/process\.env|withRole|from '\.\.\/db\/|postgres\(|reveal_contact\(|\.unsafe\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), '환경값·기본 DB·열람 함수·unsafe SQL 없음');
});

// ---- PM 6909541430: 마스킹 모양·달력 엄격 검증 ----


test('L8 이름: maskName이 실제 만드는 출력은 통과, 별표만 포함한 원문 모양은 전체 실패', async () => {
  for (const raw of ['가', '김철', '홍길동', '남궁민수', 'Al', 'John Smith', 'A Z', '가'.repeat(20), 'Fixture']) {
    const masked = maskName(raw);
    const f = fakeDeps({ rows: [row({ name_masked: masked })] });
    const r = await listMaskedLeads(f.deps, who('owner'));
    assert.equal(r.ok, true, `${raw} → ${masked}`);
    if (r.ok) assert.equal(r.items[0].nameMasked, masked);
  }
  const bads = ['FixtureFullName*', '*FixtureFullName', '홍길동*', '*길동', '홍*길*동', '홍길*동', 'A*B*C', '**', '*A', 'A**', '홍*\u0000', '홍*\n', ' 홍*동', '홍*동 ', '홍 *동', '가' + '*'.repeat(19) + '나', '1*2', '', '홍＊동'];
  for (const bad of bads) {
    const rows = Object.freeze([Object.freeze(row()), Object.freeze(row({ name_masked: bad }))]);
    const f = fakeDeps({ rows });
    const r = await listMaskedLeads(f.deps, who('owner'));
    assert.deepEqual(r, { ok: false, code: 'INVALID_DATA' }, JSON.stringify(bad));
    assert.ok(!JSON.stringify(r).includes('Fixture'), '오류에 원문 없음');
    assert.equal(rows[1].name_masked, bad, '원본 불변');
  }
});

test('L9 생성 시각: 달력·윤년·시분초·offset 엄격, Date 정규화로 받아들이지 않음', async () => {
  const good: [unknown, string][] = [
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2000-02-29T12:00:00Z', '2000-02-29T12:00:00.000Z'],
    ['2026-11-16 09:00:00+09', '2026-11-16T00:00:00.000Z'],
    ['2026-11-16T09:00:00.123456+09:00', '2026-11-16T00:00:00.123Z'],
    ['2026-11-15T23:30:00-0530', '2026-11-16T05:00:00.000Z'],
    ['2026-11-16T00:00:00+14:00', '2026-11-15T10:00:00.000Z'],
    ['2026-12-31T23:59:59Z', '2026-12-31T23:59:59.000Z'],
  ];
  for (const [v, iso] of good) {
    const r = await listMaskedLeads(fakeDeps({ rows: [row({ created_at: v })] }).deps, who('owner'));
    assert.equal(r.ok && r.items[0].createdAt, iso, String(v));
  }
  const d = new Date('2026-11-16T01:02:03.000Z');
  const dt = d.getTime();
  const rd = await listMaskedLeads(fakeDeps({ rows: [row({ created_at: d })] }).deps, who('owner'));
  assert.equal(rd.ok && rd.items[0].createdAt, '2026-11-16T01:02:03.000Z');
  assert.equal(d.getTime(), dt, 'Date 원본 불변');
  const bads: unknown[] = [
    '2026-02-31T00:00:00Z', '2026-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z',
    '2026-11-16T24:00:00Z', '2026-11-16T23:60:00Z', '2026-11-16T23:59:60Z', '2026-11-16T00:00:00', '2026-11-16', '2026-11-16T00:00:00+15:00',
    '2026-11-16T00:00:00+14:01', '2026-11-16T00:00:00+09:60', '2026-11-16T00:00:00+9', '2026-11-16T00:00:00.1234567Z', ' 2026-11-16T00:00:00Z',
    '0099-01-01T00:00:00Z', 1763254923000, {}, new Date(NaN),
  ];
  for (const bad of bads) {
    const r = await listMaskedLeads(fakeDeps({ rows: [row(), row({ created_at: bad })] }).deps, who('owner'));
    assert.deepEqual(r, { ok: false, code: 'INVALID_DATA' }, String(bad));
  }
});
