// PM 6913462268: 관리자 리드 출처 분기(leadsSource·leadsRoute) 가상 시험. 실제 Auth·DB 연결이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dbReadReady, leadsSource } from '../../src/server/admin/leadsSource';
import { adminLeadDetail, adminLeadsList, type AdminLeadsDeps } from '../../src/server/admin/leadsRoute';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';
import type { SqlTag } from '../../src/server/admin/leadsReadStore';

const OK_URL = 'postgres://app_server@127.0.0.1:54329/fideon_lrs_1234_0a1b2c3d';
const OWNER = '00000000-0000-4000-8000-000000000001';
const COUNSELOR = '00000000-0000-4000-8000-000000000002';
const ROW = { lead_id: '10000000-0000-4000-8000-000000000001', created_at: new Date('2026-11-16T00:00:01Z'), name_masked: '홍*동', phone_masked: '010-****-1001', interest: 'internet_tv', status: 'new', assigned_to: COUNSELOR, contact_time: 'FREE-TEXT' };

test('S1 출처: 미설정·mock → mock, db → db, 그 밖(대소문자·공백 포함) → invalid', () => {
  assert.equal(leadsSource({}), 'mock');
  assert.equal(leadsSource({ ADMIN_LEADS_SOURCE: '' }), 'mock');
  assert.equal(leadsSource({ ADMIN_LEADS_SOURCE: 'mock' }), 'mock');
  assert.equal(leadsSource({ ADMIN_LEADS_SOURCE: 'db' }), 'db');
  for (const v of ['DB', ' db', 'db ', 'Mock', 'database', 'supabase', 'true']) assert.equal(leadsSource({ ADMIN_LEADS_SOURCE: v }), 'invalid', v);
});

test('S2 db 읽기 준비: 지정된 로컬 폐기 시험 DB URL만, 배포 환경·원격·일반 DB·잘못된 URL 거부', () => {
  const env = (o: Record<string, string | undefined>) => ({ ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL, NODE_ENV: 'test', ...o });
  assert.equal(dbReadReady(env({ NODE_ENV: 'development' })), true);
  assert.equal(dbReadReady(env({})), true);
  assert.equal(dbReadReady(env({ DATABASE_URL: 'postgresql://u@localhost/fideon_lrs_1_abcdef01' })), true);
  const bad: [string, Record<string, string | undefined>][] = [
    ['NODE_ENV production', { NODE_ENV: 'production' }],
    ['NODE_ENV 미설정', { NODE_ENV: undefined }],
    ['NODE_ENV 빈 값', { NODE_ENV: '' }],
    ['NODE_ENV 알 수 없음', { NODE_ENV: 'unexpected' }],
    ['NODE_ENV 대소문자', { NODE_ENV: 'Test' }],
    ['source mock', { ADMIN_LEADS_SOURCE: 'mock' }],
    ['source 없음', { ADMIN_LEADS_SOURCE: undefined }],
    ['production', { VERCEL_ENV: 'production' }],
    ['preview', { VERCEL_ENV: 'preview' }],
    ['VERCEL=1', { VERCEL: '1' }],
    ['URL 없음', { DATABASE_URL: undefined }],
    ['잘못된 URL', { DATABASE_URL: 'not a url' }],
    ['원격 호스트', { DATABASE_URL: 'postgres://u@db.example.supabase.co:5432/fideon_lrs_1_abcdef01' }],
    ['loopback 흉내 호스트', { DATABASE_URL: 'postgres://u@127.0.0.1.example.com/fideon_lrs_1_abcdef01' }],
    ['IPv6·0.0.0.0', { DATABASE_URL: 'postgres://u@0.0.0.0/fideon_lrs_1_abcdef01' }],
    ['프로토콜', { DATABASE_URL: 'http://localhost/fideon_lrs_1_abcdef01' }],
    ['일반 DB 이름', { DATABASE_URL: 'postgres://u@localhost/fideon_test' }],
    ['postgres DB', { DATABASE_URL: 'postgres://u@localhost/postgres' }],
    ['이름 형식 밖', { DATABASE_URL: 'postgres://u@localhost/fideon_lrs_1_ABCDEF01' }],
    ['경로 추가', { DATABASE_URL: 'postgres://u@localhost/fideon_lrs_1_abcdef01/x' }],
    ['쿼리 문자열', { DATABASE_URL: `${OK_URL}?host=/tmp` }],
    ['해시', { DATABASE_URL: `${OK_URL}#x` }],
  ];
  for (const [label, o] of bad) assert.equal(dbReadReady(env(o)), false, label);

  const ref = 'abcdefghijklmnopqrst';
  const prod = {
    ADMIN_LEADS_SOURCE: 'db', ADMIN_AUTH_MODE: 'supabase', ADMIN_PRODUCTION_ENABLED: 'true',
    APP_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  };
  assert.equal(dbReadReady({ ...prod, DATABASE_URL: `postgresql://app_server.${ref}:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?sslmode=require` }), true);
  assert.equal(dbReadReady({ ...prod, DATABASE_URL: `postgresql://postgres:secret@db.${ref}.supabase.co:5432/postgres` }), true);
  for (const badUrl of [
    `postgresql://app_server.wrongwrongwrongwrong:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`,
    `postgresql://app_server.${ref}:secret@evil.example.com:6543/postgres`,
    `postgresql://app_server.${ref}:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/other`,
  ]) assert.equal(dbReadReady({ ...prod, DATABASE_URL: badUrl }), false, badUrl);
});

function deps(env: Record<string, string | undefined>, o: { staff?: StaffIdentity | Error; rows?: unknown[] } = {}) {
  const calls = { mockList: 0, mockDetail: 0, staff: 0, tx: 0, mode: 0 };
  const d: AdminLeadsDeps = {
    env: () => env,
    mode: () => {
      calls.mode++;
      return 'supabase';
    },
    requireStaff: async () => {
      calls.staff++;
      if (o.staff instanceof Error) throw o.staff;
      return o.staff ?? ({ actor: OWNER, session: '00000000-0000-4000-8000-0000000000aa', token: 'test-only-token', role: 'owner' } as StaffIdentity);
    },
    runInTransaction: async (fn) => {
      calls.tx++;
      const tx: SqlTag = () => Promise.resolve((o.rows ?? [ROW]) as readonly unknown[]);
      return fn(tx);
    },
    mockList: async () => {
      calls.mockList++;
      return Response.json({ ok: true, data_source: 'mock', items: [] });
    },
    mockDetail: async () => {
      calls.mockDetail++;
      return Response.json({ ok: true, data_source: 'mock', item: {} });
    },
  };
  return { d, calls };
}
const req = (qs = '') => new Request(`http://localhost/api/admin/leads${qs}`);
const body = async (r: Response) => ({ status: r.status, json: (await r.json()) as Record<string, unknown>, cc: r.headers.get('cache-control'), nosniff: r.headers.get('x-content-type-options') });

test('S3 목록: 기본 mock 유지, invalid·db 미준비는 503(Auth·DB 0회, mock 대체 없음)', async () => {
  const m = deps({});
  assert.equal((await body(await adminLeadsList(m.d, req()))).json.data_source, 'mock');
  assert.deepEqual(m.calls, { mockList: 1, mockDetail: 0, staff: 0, tx: 0, mode: 0 });
  const cases: [string, Record<string, string | undefined>, string][] = [
    ['invalid', { ADMIN_LEADS_SOURCE: 'DB' }, 'LEADS_SOURCE_INVALID'],
    ['db + URL 없음', { ADMIN_LEADS_SOURCE: 'db' }, 'LEADS_READ_DISABLED'],
    ['db + NODE_ENV production(Vercel 밖)', { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL, NODE_ENV: 'production' }, 'LEADS_READ_DISABLED'],
    ['db + NODE_ENV 미설정', { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL }, 'LEADS_READ_DISABLED'],
    ['db + NODE_ENV 알 수 없음', { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL, NODE_ENV: 'unexpected' }, 'LEADS_READ_DISABLED'],
    ['db + production', { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL, NODE_ENV: 'test', VERCEL_ENV: 'production' }, 'LEADS_READ_DISABLED'],
    ['db + preview', { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL, NODE_ENV: 'test', VERCEL_ENV: 'preview' }, 'LEADS_READ_DISABLED'],
    ['db + 원격', { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: 'postgres://u@db.example.com/fideon_lrs_1_abcdef01' }, 'LEADS_READ_DISABLED'],
    ['db + 일반 DB', { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: 'postgres://u@localhost/fideon_test' }, 'LEADS_READ_DISABLED'],
  ];
  for (const [label, env, code] of cases) {
    const { d, calls } = deps(env);
    const r = await body(await adminLeadsList(d, req()));
    assert.equal(r.status, 503, label);
    assert.deepEqual(r.json, { ok: false, code }, label);
    assert.equal(r.cc, 'private, no-store', label);
    assert.equal(r.nosniff, 'nosniff', label);
    assert.deepEqual([calls.mockList, calls.staff, calls.tx, calls.mode], [0, 0, 0, 0], label);
    assert.ok(!JSON.stringify(r.json).includes('example') && !JSON.stringify(r.json).includes('fideon_'), `${label}: URL 미노출`);
  }
  const throwing = deps({});
  throwing.d.env = () => {
    throw new Error('env SECRET');
  };
  const t = await body(await adminLeadsList(throwing.d, req()));
  assert.deepEqual(t.json, { ok: false, code: 'LEADS_SOURCE_INVALID' });
});

test('S4 목록 db 준비됨: 서버 컨텍스트 → 어댑터 → 주입 실행기, 200·권한·페이지·장애 JSON', async () => {
  const env = { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL, NODE_ENV: 'test' };
  const ok = deps(env);
  const r = await body(await adminLeadsList(ok.d, req('?limit=5&actor=forged&role=owner')));
  assert.equal(r.status, 200);
  assert.equal(r.json.data_source, 'db');
  assert.deepEqual(Object.keys((r.json.items as object[])[0]).sort(), ['assignedTo', 'createdAt', 'id', 'interest', 'nameMasked', 'phoneMasked', 'status']);
  assert.ok(!JSON.stringify(r.json).includes('FREE-TEXT'));
  assert.deepEqual([ok.calls.mockList, ok.calls.staff, ok.calls.tx], [0, 1, 1]);
  const dev = deps({ ...env, NODE_ENV: 'development' });
  assert.equal((await adminLeadsList(dev.d, req())).status, 200, 'development 허용');
  const c = deps(env, { staff: { actor: COUNSELOR, session: '00000000-0000-4000-8000-0000000000bb', token: 't', role: 'counselor' } as StaffIdentity });
  assert.equal((await adminLeadsList(c.d, req())).status, 200);
  const other = deps(env, { staff: { actor: OWNER, session: '00000000-0000-4000-8000-0000000000bb', token: 't', role: 'counselor' } as StaffIdentity });
  assert.deepEqual((await body(await adminLeadsList(other.d, req()))).json, { ok: false, code: 'UNAVAILABLE' }, 'counselor 범위 밖 행');
  for (const [label, o, status, code] of [
    ['미인증', { staff: new StaffAuthError(401, 'UNAUTHENTICATED') }, 401, 'UNAUTHENTICATED'],
    ['reviewer', { staff: { actor: OWNER, session: OWNER, token: 't', role: 'reviewer' } as StaffIdentity }, 403, 'FORBIDDEN'],
    ['잘못된 행', { rows: [{ ...ROW, name_masked: 'FullName*' }] }, 503, 'UNAVAILABLE'],
  ] as const) {
    const x = deps(env, o as never);
    const b = await body(await adminLeadsList(x.d, req()));
    assert.equal(b.status, status, label);
    assert.deepEqual(b.json, { ok: false, code }, label);
    assert.equal(b.cc, 'private, no-store', label);
  }
  const p = deps(env);
  assert.equal((await adminLeadsList(p.d, req('?limit=999'))).status, 400);
  assert.equal(p.calls.tx, 0);
});

test('S5 상세: mock은 기존 가상 상세, db·invalid는 503으로 막아 섞지 않음(Auth·DB 0회)', async () => {
  const m = deps({});
  assert.equal((await body(await adminLeadDetail(m.d))).json.data_source, 'mock');
  for (const [env, code] of [[{ ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: OK_URL, NODE_ENV: 'test' }, 'LEADS_DETAIL_UNAVAILABLE'], [{ ADMIN_LEADS_SOURCE: 'x' }, 'LEADS_SOURCE_INVALID']] as const) {
    const { d, calls } = deps(env);
    const r = await body(await adminLeadDetail(d));
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { ok: false, code });
    assert.equal(r.cc, 'private, no-store');
    assert.deepEqual([calls.mockDetail, calls.staff, calls.tx], [0, 0, 0]);
  }
});

test('S6 route 파일은 Next 허용 export만, 기본값 mock은 .env.example에 명시, 페이지는 새 모듈 미연결', () => {
  const root = path.resolve(__dirname, '../..');
  for (const f of ['src/app/api/admin/leads/route.ts', 'src/app/api/admin/leads/[id]/route.ts']) {
    const src = readFileSync(path.join(root, f), 'utf8');
    const exports = [...src.matchAll(/^export\s+(?:async\s+)?(?:const|function|let)\s+(\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(exports, ['GET', 'dynamic', 'runtime'], f);
  }
  assert.match(readFileSync(path.join(root, '.env.example'), 'utf8'), /^ADMIN_LEADS_SOURCE=mock$/m);
  for (const f of ['src/app/admin/page.tsx', 'src/app/admin/AdminMockView.tsx']) {
    assert.ok(!/leadsRoute|leadsReadApi|leadsReadStore|leadsSource/.test(readFileSync(path.join(root, f), 'utf8')), f);
  }
});
