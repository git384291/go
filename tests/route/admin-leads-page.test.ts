// PM 6915664371: /admin 렌더 결정(leadsRender) 가상 시험. 요소 트리를 실제로 펼쳐(함수 컴포넌트 호출) 화면 문자열을 확인한다.
// 가상 서버 의존성만 쓴다. 원격 Auth E2E·실제 DB 연결이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderAdminLeads, PAGE_SIZE, type AdminLeadsPageDeps } from '../../src/app/admin/leadsRender';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';
import type { SqlTag } from '../../src/server/admin/leadsReadStore';

const OWNER = '00000000-0000-4000-8000-000000000001';
const CA = '00000000-0000-4000-8000-000000000002';
const CB = '00000000-0000-4000-8000-000000000003';
const OK_ENV = { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: 'postgres://app_server@127.0.0.1:54329/fideon_lrs_1_abcdef01', NODE_ENV: 'test' };
const MOCK_MARK = 'MOCK-VIEW-MARKER';
const row = (n: number, assigned: string | null, extra: Record<string, unknown> = {}) => ({
  lead_id: `10000000-0000-4000-8000-00000000000${n}`, created_at: new Date('2026-11-16T00:00:01Z'), name_masked: '홍*동', phone_masked: `010-****-100${n}`,
  interest: 'internet_tv', status: 'new', assigned_to: assigned, contact_time: 'FREE-TEXT-SECRET', phone_enc: 'v1:ENC-SECRET', ...extra,
});
const who = (role: string, actor = OWNER) => ({ actor, session: '00000000-0000-4000-8000-0000000000aa', token: 'TOKEN-SECRET', role }) as StaffIdentity;

function deps(env: Record<string, string | undefined>, o: { staff?: StaffIdentity | Error; rows?: unknown[] | Error; mode?: 'supabase' | 'disabled'; mockVisible?: boolean; sp?: Record<string, string | string[]> } = {}) {
  const n = { staff: 0, tx: 0, mock: 0, sql: [] as unknown[][] };
  const d: AdminLeadsPageDeps = {
    env: () => env,
    mode: () => o.mode ?? 'supabase',
    mockVisible: () => o.mockVisible ?? false,
    requireStaff: async () => {
      n.staff++;
      if (o.staff instanceof Error) throw o.staff;
      return o.staff ?? who('owner');
    },
    runInTransaction: async (fn) => {
      n.tx++;
      const tx: SqlTag = (_s, ...v) => {
        n.sql.push(v);
        return o.rows instanceof Error ? Promise.reject(o.rows) : Promise.resolve((o.rows ?? [row(1, CA), row(2, null), row(3, OWNER)]) as readonly unknown[]);
      };
      return fn(tx);
    },
    searchParams: o.sp ?? {},
    headerExtra: (role) => createElement('span', { className: 'admin-role' }, `ROLE:${role}`),
    mockView: (h?: ReactNode) => {
      n.mock++;
      return createElement('div', null, MOCK_MARK, h);
    },
  };
  return { d, n };
}

/** 요소 트리를 펼쳐(함수 컴포넌트 호출) 모든 문자열과 props 값을 모은다 */
function text(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const x of node) text(x, out);
    return out;
  }
  if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)(el.props), out);
    for (const [k, v] of Object.entries(el.props)) {
      if (k === 'children') text(v, out);
      else if (typeof v === 'string') out.push(`${k}=${v}`);
    }
  }
  return out;
}
async function render(d: AdminLeadsPageDeps) {
  const r = await renderAdminLeads(d);
  return 'redirect' in r ? { redirect: r.redirect, s: '' } : { redirect: null, s: text(r.element).join('|') };
}

test('V1 mock(기본·미설정): 기존 화면 그대로(인증 꺼짐 로컬 가상·잠금, 인증 켜짐 requireStaff 뒤 가상)', async () => {
  const locked = deps({}, { mode: 'disabled' });
  assert.match((await render(locked.d)).s, /인증 연결 후 열립니다/);
  assert.deepEqual([locked.n.mock, locked.n.staff, locked.n.tx], [0, 0, 0]);
  const dev = deps({ ADMIN_LEADS_SOURCE: 'mock' }, { mode: 'disabled', mockVisible: true });
  assert.match((await render(dev.d)).s, new RegExp(MOCK_MARK));
  const on = deps({}, { staff: who('counselor', CA) });
  const r = await render(on.d);
  assert.ok(r.s.includes(MOCK_MARK) && r.s.includes('ROLE:counselor'));
  assert.equal(on.n.tx, 0, 'mock은 DB 목록을 읽지 않음');
  const out = deps({}, { staff: new StaffAuthError(401, 'UNAUTHENTICATED') });
  assert.equal((await render(out.d)).redirect, '/admin/login');
});

test('V2 invalid·db 미준비·인증 꺼짐·권한·장애: 잠금/실패 화면만, mock 대체 없음, 행 로드 0', async () => {
  const cases: [string, Record<string, string | undefined>, Parameters<typeof deps>[1], RegExp, number][] = [
    ['invalid', { ADMIN_LEADS_SOURCE: 'DB' }, {}, /설정을 확인할 수 없어/, 0],
    ['db + production', { ...OK_ENV, NODE_ENV: 'production' }, {}, /로컬 시험 DB 준비 전/, 0],
    ['db + 원격 URL', { ...OK_ENV, DATABASE_URL: 'postgres://u@db.example.com/fideon_lrs_1_abcdef01' }, {}, /로컬 시험 DB 준비 전/, 0],
    ['db + 인증 꺼짐', OK_ENV, { mode: 'disabled', mockVisible: true }, /인증 연결 후 열립니다/, 0],
    ['db + 403', OK_ENV, { staff: new StaffAuthError(403, 'FORBIDDEN') }, /볼 수 없습니다/, 1],
    ['db + 인증 장애', OK_ENV, { staff: new Error('db down SECRET') }, /불러오지 못했습니다/, 1],
    ['db + reviewer', OK_ENV, { staff: who('reviewer') }, /볼 수 없습니다/, 1],
    ['db + policy_editor', OK_ENV, { staff: who('policy_editor') }, /볼 수 없습니다/, 1],
  ];
  for (const [label, env, o, re, staffCalls] of cases) {
    const { d, n } = deps(env, o);
    const r = await render(d);
    assert.equal(r.redirect, null, label);
    assert.match(r.s, re, label);
    assert.ok(!r.s.includes(MOCK_MARK), `${label}: mock 대체 없음`);
    assert.ok(!/010-\*{4}|홍\*동|SECRET|fideon_lrs|example\.com|54329/.test(r.s), `${label}: 행·내부 값 없음`);
    assert.deepEqual([n.mock, n.tx, n.staff], [0, 0, staffCalls], label);
  }
  const out = deps(OK_ENV, { staff: new StaffAuthError(401, 'UNAUTHENTICATED') });
  assert.equal((await render(out.d)).redirect, '/admin/login');
  assert.equal(out.n.tx, 0);
});

test('V3 db owner: 7키 마스킹 목록·배정 표시(미배정/배정됨/내 배정)·시험 데이터 표시, 숨긴 값·건수 통계·조작 버튼 없음', async () => {
  const { d, n } = deps(OK_ENV);
  const r = await render(d);
  assert.ok(r.s.includes('로컬 시험 데이터') && r.s.includes('실제 고객·영업 실적이 아니며'));
  for (const s of ['홍*동', '010-****-1001', '010-****-1003', '인터넷+TV', '2026-11-16 09:00', '미배정', '배정됨', '내 배정', '신규', 'ROLE:owner']) assert.ok(r.s.includes(s), s);
  assert.ok(!/SECRET|FREE-TEXT|v1:|TOKEN|원문 보기|메모|내보내기|상태 변경|배정하기/.test(r.s), '숨긴 값·조작 없음');
  assert.ok(!/전체 \d|신규 \d|접수전환 \d/.test(r.s), '건수 통계 없음');
  assert.deepEqual(n.sql[0].slice(3), [PAGE_SIZE, 0]);
  assert.equal(n.mock, 0);
});

test('V4 db counselor: 본인 배정만, 범위 밖 행이 오면 실패 화면(누락 성공 아님)', async () => {
  const ok = deps(OK_ENV, { staff: who('counselor', CA), rows: [row(1, CA)] });
  const r = await render(ok.d);
  assert.ok(r.s.includes('내 배정') && !r.s.includes('미배정') && !r.s.includes('배정됨'));
  for (const bad of [[row(1, CA), row(2, CB)], [row(1, CA), row(2, null)]]) {
    const x = deps(OK_ENV, { staff: who('counselor', CA), rows: bad });
    const rr = await render(x.d);
    assert.match(rr.s, /불러오지 못했습니다/);
    assert.ok(!rr.s.includes('010-****'));
  }
});

test('V5 빈 목록과 실패 구분, 페이지 이동은 검증한 offset만(전체 건수 미확인 표시)', async () => {
  const empty = await render(deps(OK_ENV, { rows: [] }).d);
  assert.match(empty.s, /표시할 상담이 없습니다/);
  assert.ok(!/불러오지 못했습니다/.test(empty.s));
  const failed = await render(deps(OK_ENV, { rows: Object.assign(new Error('relation SECRET'), { code: '57P01' }) }).d);
  assert.match(failed.s, /불러오지 못했습니다/);
  assert.ok(!failed.s.includes('SECRET'));
  const bad = await render(deps(OK_ENV, { rows: [row(1, null, { name_masked: 'FullName*' })] }).d);
  assert.match(bad.s, /불러오지 못했습니다/);
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => row(1, null, { lead_id: `10000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}` }));
  const page = deps(OK_ENV, { rows: full, sp: { offset: '20' } });
  const p = await render(page.d);
  assert.ok(p.s.includes('href=/admin?offset=0') && p.s.includes('href=/admin?offset=40') && p.s.includes('전체 건수 미확인'));
  assert.deepEqual(page.n.sql[0].slice(3), [PAGE_SIZE, 20]);
  for (const off of ['-1', '1.5', 'abc', '15', '200000', ['20', '40']] as (string | string[])[]) {
    const x = deps(OK_ENV, { sp: { offset: off as string } });
    const rr = await render(x.d);
    assert.match(rr.s, /불러오지 못했습니다/, String(off));
    assert.equal(x.n.tx, 0, String(off));
  }
  // query의 role·actor·token은 읽지 않는다
  const forged = deps(OK_ENV, { staff: who('counselor', CA), rows: [row(1, CA)], sp: { role: 'owner', actor: OWNER, token: 'forged' } });
  await render(forged.d);
  assert.deepEqual(forged.n.sql[0].slice(0, 3), [CA, '00000000-0000-4000-8000-0000000000aa', 'TOKEN-SECRET']);
});

test('V7 최대 offset 경계: 허용 범위를 넘는 다음 링크를 만들지 않음(최대 직전·최대·빈 마지막 페이지)', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => row(1, null, { lead_id: `10000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}` }));
  const at = async (off: string, rows: unknown[]) => (await render(deps(OK_ENV, { rows, sp: { offset: off } }).d)).s;
  const before = await at('99980', full);
  assert.ok(before.includes('href=/admin?offset=100000') && before.includes('href=/admin?offset=99960'), '최대 직전: 다음=최대');
  assert.ok(!before.includes('마지막 페이지'));
  const max = await at('100000', full);
  assert.ok(!/offset=1000[2-9]\d|offset=100020/.test(max), '최대: 허용 밖 다음 링크 없음');
  assert.ok(max.includes('href=/admin?offset=99980') && max.includes('마지막 페이지입니다'), '이전 이동·안내 유지');
  assert.ok(!max.includes('다음 페이지가 있을 수 있습니다'));
  const empty = await at('100000', []);
  assert.ok(empty.includes('이 페이지에 표시할 상담이 없습니다') && empty.includes('href=/admin?offset=99980') && !empty.includes('offset=100020'));
  const over = await render(deps(OK_ENV, { sp: { offset: '100020' } }).d);
  assert.match(over.s, /불러오지 못했습니다/, '로더는 여전히 100020 거부(범위 확장 없음)');
});

const req = createRequire(import.meta.url);
let realDeps = true;
try {
  req.resolve('next/package.json');
  req.resolve('@supabase/ssr');
} catch {
  realDeps = false;
}

test('V6 실제 서버 기본 의존성(leadsDefaults·adminMockVisible): 인증 기본값(꺼짐)·기본 mock 잠금, db 출처도 잠금(목록·가상 표식 없음)', { skip: realDeps ? false : 'next·@supabase/ssr 미설치 — CI·Mac에서 실행' }, async () => {
  // page.tsx는 로그아웃 Server Action(next/navigation 정적 import)을 함께 불러와 이 시험 조건(react-server)에서 직접 실행할 수 없다.
  // 그래서 page.tsx가 넘기는 것과 같은 실제 기본 의존성으로 렌더 결정을 실행한다. 실Next HTML 경계는 server smoke가 맡는다.
  const keys = ['ADMIN_AUTH_MODE', 'ADMIN_LEADS_SOURCE'] as const;
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  try {
    const { defaultLeadsServerDeps } = await import('../../src/server/admin/leadsDefaults');
    const { adminMockVisible } = await import('../../src/server/auth/adminAuthMode');
    const real = (): AdminLeadsPageDeps => ({
      ...defaultLeadsServerDeps(),
      mockVisible: () => adminMockVisible(),
      searchParams: {},
      headerExtra: () => null,
      mockView: () => createElement('div', null, MOCK_MARK),
    });
    const r1 = await renderAdminLeads(real());
    const s1 = 'element' in r1 ? text(r1.element).join('|') : 'redirect';
    assert.match(s1, /인증 연결 후 열립니다/);
    assert.ok(!s1.includes(MOCK_MARK) || process.env.NODE_ENV === 'development');
    assert.ok(!/010-|로컬 시험 데이터/.test(s1));
    process.env.ADMIN_LEADS_SOURCE = 'db';
    const r2 = await renderAdminLeads(real());
    const s2 = 'element' in r2 ? text(r2.element).join('|') : 'redirect';
    assert.match(s2, /로컬 시험 DB 준비 전/);
    assert.ok(!s2.includes(MOCK_MARK) && !/010-/.test(s2));
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});
