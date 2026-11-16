// PM 6910895023: 마스킹 목록 HTTP 응답 조합(leadsReadApi) 가상 시험. 실제 Response 수준에서 확인한다.
// 가상 직원·가짜 의존성만 쓴다. 실제 Auth·DB 검증이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { listLeadsReadResponse, type LeadsReadApiDeps } from '../../src/server/admin/leadsReadApi';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';
import type { ListResult, MaskedLead } from '../../src/server/admin/leadsReadStore';

const OWNER = '00000000-0000-4000-8000-000000000001';
const COUNSELOR = '00000000-0000-4000-8000-000000000002';
const id = (role: string, actor = OWNER) => ({ actor, session: '00000000-0000-4000-8000-0000000000aa', token: 'test-only-SECRET-TOKEN', role }) as StaffIdentity;
const ITEM: MaskedLead = Object.freeze({ id: '10000000-0000-4000-8000-000000000001', createdAt: '2026-11-16T00:00:01.000Z', nameMasked: '홍*동', phoneMasked: '010-****-1001', interest: 'internet_tv', status: 'new', assignedTo: COUNSELOR });

function deps(o: { mode?: string; ready?: boolean | (() => boolean); staff?: StaffIdentity | Error; list?: ListResult | Error } = {}) {
  const calls = { staff: 0, list: 0, args: [] as unknown[] };
  const ready = o.ready;
  const d: LeadsReadApiDeps = {
    mode: () => (o.mode ?? 'supabase') as 'supabase',
    readReady: typeof ready === 'function' ? ready : () => ready !== false,
    requireStaff: async () => {
      calls.staff++;
      if (o.staff instanceof Error) throw o.staff;
      return o.staff ?? id('owner');
    },
    listLeads: async (who, page) => {
      calls.list++;
      calls.args.push({ who, page });
      if (o.list instanceof Error) throw o.list;
      return 'list' in o ? (o.list as ListResult) : { ok: true, items: [ITEM] };
    },
  };
  return { d, calls };
}
const q = (s = '') => new URLSearchParams(s);
async function read(res: Response) {
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown>, h: res.headers };
}
const assertHeaders = (h: Headers, label: string) => {
  assert.equal(h.get('cache-control'), 'private, no-store', label);
  assert.equal(h.get('x-content-type-options'), 'nosniff', label);
  assert.match(h.get('content-type') ?? '', /^application\/json/, label);
};

test('A1 인증 모드 꺼짐·읽기 준비 꺼짐(예외 포함): requireStaff·목록 0회, 503', async () => {
  for (const [label, o, code] of [
    ['모드 disabled', { mode: 'disabled' }, 'ADMIN_AUTH_DISABLED'],
    ['모드 알 수 없음', { mode: 'SUPABASE' }, 'ADMIN_AUTH_DISABLED'],
    ['읽기 준비 꺼짐', { ready: false }, 'LEADS_READ_DISABLED'],
    ['읽기 준비 예외', { ready: () => { throw new Error('x'); } }, 'LEADS_READ_DISABLED'],
  ] as const) {
    const { d, calls } = deps(o as never);
    const r = await read(await listLeadsReadResponse(d, q()));
    assert.equal(r.status, 503, label);
    assert.deepEqual(r.body, { ok: false, code }, label);
    assert.deepEqual([calls.staff, calls.list], [0, 0], label);
    assertHeaders(r.h, label);
  }
});

test('A2 미인증 401·권한 403·인증 장애 503, 목록 0회', async () => {
  const cases: [string, Error | StaffIdentity, number, string][] = [
    ['미인증', new StaffAuthError(401, 'UNAUTHENTICATED'), 401, 'UNAUTHENTICATED'],
    ['권한 없음', new StaffAuthError(403, 'FORBIDDEN'), 403, 'FORBIDDEN'],
    ['인증 장애', new Error('db down SECRET'), 503, 'UNAVAILABLE'],
    ['reviewer', id('reviewer'), 403, 'FORBIDDEN'],
    ['policy_editor', id('policy_editor'), 403, 'FORBIDDEN'],
    ['알 수 없는 역할', id('admin'), 403, 'FORBIDDEN'],
  ];
  for (const [label, staff, status, code] of cases) {
    const { d, calls } = deps({ staff });
    const r = await read(await listLeadsReadResponse(d, q()));
    assert.equal(r.status, status, label);
    assert.deepEqual(r.body, { ok: false, code }, label);
    assert.equal(calls.list, 0, label);
    assert.ok(!r.text.includes('SECRET'), label);
    assertHeaders(r.h, label);
  }
});

test('A3 owner·counselor 정상 200: 명시 필드·7키 DTO만, 서버 컨텍스트만 전달(query의 actor·role 무시)', async () => {
  for (const who of [id('owner'), id('counselor', COUNSELOR)]) {
    const leaky = { ...ITEM, contactTime: 'FREE-TEXT', phoneEnc: 'v1:SECRET', notes: 'MEMO' } as unknown as MaskedLead;
    const { d, calls } = deps({ staff: who, list: { ok: true, items: [leaky] } });
    const r = await read(await listLeadsReadResponse(d, q(`limit=10&offset=20&actor=${OWNER}&role=owner&token=forged&session=x`)));
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['data_source', 'items', 'ok']);
    assert.equal(r.body.data_source, 'db');
    assert.deepEqual(r.body.items, [{ ...ITEM }]);
    assert.ok(!/FREE-TEXT|SECRET|MEMO|forged|test-only/.test(r.text));
    assert.deepEqual(calls.args, [{ who, page: { limit: 10, offset: 20 } }], '서버 검증 컨텍스트와 검증한 페이지만');
    assertHeaders(r.h, who.role);
  }
  const empty = deps({ list: { ok: true, items: [] } });
  const e = await read(await listLeadsReadResponse(empty.d, q()));
  assert.deepEqual(e.body, { ok: true, data_source: 'db', items: [] });
  assert.deepEqual((empty.calls.args[0] as { page: unknown }).page, { limit: 50, offset: 0 }, '기본 페이지');
});

test('A4 잘못된 페이지 400(목록 0회)', async () => {
  for (const s of ['limit=0', 'limit=201', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'offset=-1', 'offset=100001', 'limit=1&limit=2', 'offset=1e3', 'limit=%2010', 'limit=0x10']) {
    const { d, calls } = deps();
    const r = await read(await listLeadsReadResponse(d, q(s)));
    assert.equal(r.status, 400, s);
    assert.deepEqual(r.body, { ok: false, code: 'INVALID_PAGE' }, s);
    assert.equal(calls.list, 0, s);
    assertHeaders(r.h, s);
  }
});

test('A5 목록 오류 매핑: 내부 판정·원문 미노출, 장애를 빈 목록으로 숨기지 않음', async () => {
  const cases: [ListResult | Error | unknown, number, string][] = [
    [{ ok: false, code: 'FORBIDDEN' }, 403, 'FORBIDDEN'],
    [{ ok: false, code: 'INVALID_PAGE' }, 400, 'INVALID_PAGE'],
    [{ ok: false, code: 'DISABLED' }, 503, 'LEADS_READ_DISABLED'],
    [{ ok: false, code: 'UNAVAILABLE' }, 503, 'UNAVAILABLE'],
    [{ ok: false, code: 'INVALID_DATA' }, 503, 'UNAVAILABLE'],
    [{ ok: false, code: 'SCOPE_VIOLATION' }, 503, 'UNAVAILABLE'],
    [{ ok: false, code: 'SOMETHING_NEW' }, 503, 'UNAVAILABLE'],
    [{ ok: true, items: 'not-array' }, 503, 'UNAVAILABLE'],
    [null, 503, 'UNAVAILABLE'],
    [Object.assign(new Error('relation pii.customers SECRET'), { query: 'select SECRET', parameters: ['test-only-SECRET-TOKEN'] }), 503, 'UNAVAILABLE'],
  ];
  for (const [list, status, code] of cases) {
    const { d } = deps({ list: list as ListResult });
    const r = await read(await listLeadsReadResponse(d, q()));
    assert.equal(r.status, status, JSON.stringify(list));
    assert.deepEqual(r.body, { ok: false, code }, JSON.stringify(list));
    assert.ok(!/SECRET|INVALID_DATA|SCOPE_VIOLATION|pii\./.test(r.text));
    assertHeaders(r.h, code);
  }
});

test('A6 기존 route·page 미연결, 모듈은 환경값·기본 DB를 읽지 않음, 기존 가상 API는 mock 유지', () => {
  const root = path.resolve(__dirname, '../../src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(root);
  // 허용된 import: 출처 분기 조합(leadsRoute.ts)과 목록 route(PM 6913462268). 페이지·상세 route·클라이언트 코드는 없어야 한다
  const allowed = [/server[\\/]admin[\\/]leadsRead(Api|Store)\.ts$/, /server[\\/]admin[\\/]leadsRoute\.ts$/, /app[\\/]api[\\/]admin[\\/]leads[\\/]route\.ts$/];
  const importers = files.filter((f) => !allowed.some((re) => re.test(f)) && /leadsReadApi|leadsReadStore/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(importers, []);
  const src = readFileSync(path.join(root, 'server/admin/leadsReadApi.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|withRole|from '\.\.\/db\/|postgres|fetch\(/.test(src));
  assert.match(readFileSync(path.join(root, 'server/admin/leadsApi.ts'), 'utf8'), /data_source: 'mock'/);
});

test('A7 응답 조립 경계: null·불완전·형식 밖 항목, 직렬화 불가·getter 예외 → 503 UNAVAILABLE(no-store), 원문 미반환', async () => {
  const bigint = { ...ITEM, assignedTo: null, extra: BigInt(1) };
  const throwing = Object.defineProperty({ ...ITEM }, 'nameMasked', { enumerable: true, get() { throw new Error('getter SECRET'); } });
  const circular: Record<string, unknown> = { ...ITEM };
  circular.self = circular;
  const cases: [string, unknown[]][] = [
    ['null 항목', [null]],
    ['불완전 항목', [{ id: ITEM.id }]],
    ['원문 이름', [{ ...ITEM, nameMasked: 'FullName*' }]],
    ['원문 번호', [{ ...ITEM, phoneMasked: '010-1234-5678' }]],
    ['시각 형식 밖', [{ ...ITEM, createdAt: '2026-02-31T00:00:00.000Z' }]],
    ['예약 상품', [{ ...ITEM, interest: 'cctv_security' }]],
    ['정상 + null 혼합', [ITEM, null]],
    ['getter 예외', [throwing]],
  ];
  for (const [label, items] of cases) {
    const { d } = deps({ list: { ok: true, items } as unknown as ListResult });
    const res = await listLeadsReadResponse(d, q());
    const r = await read(res);
    assert.equal(r.status, 503, label);
    assert.deepEqual(r.body, { ok: false, code: 'UNAVAILABLE' }, label);
    assert.ok(!/SECRET|FullName|1234-5678/.test(r.text), label);
    assertHeaders(r.h, label);
  }
  // 직렬화 불가 값이 있어도(추가 필드) 7키만 골라 직렬화하므로 정상 항목은 200, 추가 필드는 버린다
  for (const extra of [bigint, circular]) {
    const { d } = deps({ list: { ok: true, items: [extra] } as unknown as ListResult });
    const r = await read(await listLeadsReadResponse(d, q()));
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys((r.body.items as object[])[0]).sort(), ['assignedTo', 'createdAt', 'id', 'interest', 'nameMasked', 'phoneMasked', 'status']);
  }
  // 의존성 자체가 예외를 던지는 경우(mode)
  const { d } = deps();
  d.mode = () => { throw new Error('mode SECRET'); };
  const m = await read(await listLeadsReadResponse(d, q()));
  assert.equal(m.status, 503);
  assert.ok(!m.text.includes('SECRET'));
});
