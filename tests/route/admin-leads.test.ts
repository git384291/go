// 관리자 리드 조회 API(가상 데이터 전용) 경로 시험.
// L1~L8: API 본체(leadsApi.ts)에 판정 의존성을 주입해 HTTP 응답 수준으로 확인한다(네트워크·DB 없음).
// L9: 실제 route.ts 파일(인증 꺼짐 기본값)을 호출한다. next·@supabase/ssr 미설치 환경에서는 건너뛰고 통과로 세지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { leadDetail, listLeads, type LeadsApiDeps } from '../../src/server/admin/leadsApi';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import { StaffSessionUnavailable, type StaffIdentity } from '../../src/server/auth/staffSession';
import { MOCK_COUNSELOR_ID, MOCK_LEADS, MOCK_OWNER_ID } from '../../src/mock/leads';

const SESSION = '10000000-0000-4000-8000-000000000009';
const who = (role: StaffIdentity['role'], actor = MOCK_OWNER_ID): StaffIdentity => ({ actor, session: SESSION, token: '1.9999999999.' + 'a'.repeat(64), role });
const OWNER = who('owner');
const COUNSELOR = who('counselor', MOCK_COUNSELOR_ID);
const OTHER_COUNSELOR = who('counselor', '00000000-0000-4000-8000-000000000004');

function deps(identity: StaffIdentity | Error, mode: 'supabase' | 'disabled' = 'supabase') {
  let calls = 0;
  const d: LeadsApiDeps = {
    mode: () => mode,
    requireStaff: async () => { calls++; if (identity instanceof Error) throw identity; return identity; },
  };
  return { d, calls: () => calls };
}

async function read(r: Response) {
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  const text = await r.text();
  for (const leak of [SESSION, 'a'.repeat(64), 'private-detail']) assert.ok(!text.includes(leak), `응답에 ${leak} 노출`);
  return { status: r.status, body: JSON.parse(text) };
}

test('L1 인증 꺼짐: 판정 함수 호출 없이 503, 가상 데이터도 내보내지 않음', async () => {
  const x = deps(OWNER, 'disabled');
  for (const r of [await listLeads(x.d), await leadDetail(x.d, 'mock-0007')]) {
    assert.deepEqual(await read(r), { status: 503, body: { ok: false, code: 'ADMIN_AUTH_DISABLED' } });
  }
  assert.equal(x.calls(), 0);
});

test('L2 미인증 401, MFA 미완료 등 403, 인증·DB 장애 503 — 오류 원문 비노출', async () => {
  const cases: [Error, number, string][] = [
    [new StaffAuthError(401, 'UNAUTHENTICATED'), 401, 'UNAUTHENTICATED'],
    [new StaffAuthError(401, 'NO_SESSION'), 401, 'UNAUTHENTICATED'],
    [new StaffAuthError(403, 'MFA_REQUIRED'), 403, 'FORBIDDEN'],
    [new StaffSessionUnavailable(), 503, 'UNAVAILABLE'],
    [new Error('private-detail AUTH_UNAVAILABLE'), 503, 'UNAVAILABLE'],
  ];
  for (const [err, status, code] of cases) {
    for (const r of [await listLeads(deps(err).d), await leadDetail(deps(err).d, 'mock-0006')]) {
      assert.deepEqual(await read(r), { status, body: { ok: false, code } });
    }
  }
});

test('L3 reviewer·policy_editor는 목록·상세 모두 403', async () => {
  for (const role of ['reviewer', 'policy_editor'] as const) {
    const x = deps(who(role));
    assert.deepEqual(await read(await listLeads(x.d)), { status: 403, body: { ok: false, code: 'FORBIDDEN' } });
    assert.deepEqual(await read(await leadDetail(x.d, 'mock-0007')), { status: 403, body: { ok: false, code: 'FORBIDDEN' } });
  }
});

test('L4 대표(owner)는 전체 목록, 가상 데이터 표시, 목록에는 메모·배정 ID 없음', async () => {
  const { status, body } = await read(await listLeads(deps(OWNER).d));
  assert.equal(status, 200);
  assert.equal(body.data_source, 'mock');
  assert.deepEqual(body.items.map((i: { id: string }) => i.id), MOCK_LEADS.map((l) => l.id));
  for (const i of body.items) {
    assert.deepEqual(Object.keys(i).sort(), ['assignee', 'createdAt', 'id', 'interest', 'nameMasked', 'phoneMasked', 'status', 'statusLabel']);
    assert.match(i.phoneMasked, /^010-\*{4}-\d{4}$/);
  }
});

test('L5 상담원(counselor)은 본인 배정 건만, 미배정·타인 배정은 목록에 없음', async () => {
  const mine = MOCK_LEADS.filter((l) => l.assigneeId === MOCK_COUNSELOR_ID).map((l) => l.id);
  assert.ok(mine.length > 0 && mine.length < MOCK_LEADS.length);
  const { status, body } = await read(await listLeads(deps(COUNSELOR).d));
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((i: { id: string }) => i.id), mine);
  const other = await read(await listLeads(deps(OTHER_COUNSELOR).d));
  assert.deepEqual(other.body.items, []);
});

test('L6 상세: 상담원은 본인 배정만, 타인 배정·미배정·없는 ID·형식 오류는 모두 같은 404', async () => {
  const own = await read(await leadDetail(deps(COUNSELOR).d, 'mock-0006'));
  assert.equal(own.status, 200);
  assert.equal(own.body.item.id, 'mock-0006');
  assert.equal(own.body.data_source, 'mock');
  assert.ok(Array.isArray(own.body.item.notes));
  const notFound = { status: 404, body: { ok: false, code: 'NOT_FOUND' } };
  for (const id of ['mock-0004', 'mock-0003', 'mock-0007', 'mock-9999', '../mock-0006', 'MOCK-0006', '', undefined, 6]) {
    assert.deepEqual(await read(await leadDetail(deps(COUNSELOR).d, id)), notFound, String(id));
  }
});

test('L7 상세: 대표는 모든 가상 건 조회, 없는 ID는 404', async () => {
  for (const l of MOCK_LEADS) {
    const r = await read(await leadDetail(deps(OWNER).d, l.id));
    assert.equal(r.status, 200);
    assert.equal(r.body.item.phoneMasked, l.phoneMasked);
  }
  assert.equal((await read(await leadDetail(deps(OWNER).d, 'mock-0000'))).status, 404);
});

test('L8 응답 수정이 원본 가상 데이터에 영향 없음(복사본 반환)', async () => {
  const r = await read(await leadDetail(deps(OWNER).d, 'mock-0006'));
  r.body.item.notes.push({ at: 'x', by: 'x', body: 'x' });
  assert.equal(MOCK_LEADS.find((l) => l.id === 'mock-0006')!.notes.length, 1);
});

const req = createRequire(import.meta.url);
let realDeps = true;
try { req.resolve('next/package.json'); req.resolve('@supabase/ssr'); } catch { realDeps = false; }

test('L9 실제 route.ts: 인증 기본값(꺼짐)에서 목록·상세 모두 503 + no-store', { skip: realDeps ? false : 'next·@supabase/ssr 미설치 — CI·Mac에서 실행' }, async () => {
  const saved = process.env.ADMIN_AUTH_MODE;
  delete process.env.ADMIN_AUTH_MODE;
  try {
    const list = await import('../../src/app/api/admin/leads/route');
    const detail = await import('../../src/app/api/admin/leads/[id]/route');
    for (const r of [await list.GET(new Request('http://localhost/api/admin/leads')), await detail.GET(new Request('http://localhost/api/admin/leads/mock-0006'), { params: Promise.resolve({ id: 'mock-0006' }) })]) {
      assert.deepEqual(await read(r), { status: 503, body: { ok: false, code: 'ADMIN_AUTH_DISABLED' } });
    }
  } finally {
    if (saved !== undefined) process.env.ADMIN_AUTH_MODE = saved;
  }
});
