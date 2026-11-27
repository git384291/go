// PM 11/27 CRM ⑤: 설치·정산·환수 관리자 API 시험(CA1~CA6). 가짜 의존성만 — DB 판정(상태 순서·환수 위험·추가 전용·대표만)은 db/tests/99_install_settlement.sql이 확인.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractAction, contractList } from '../../src/server/admin/contractAdmin';
import type { CrmAdminDeps } from '../../src/server/admin/crmAdmin';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const ENV = { ADMIN_CRM_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'secret-tok', role }) as StaffIdentity;
const LEAD = '10000000-0000-4000-8000-000000000001';
const row = (o: Record<string, unknown> = {}) => ({ lead_id: LEAD, name_masked: '홍*동', carrier: 'KT', status: 'terminated', install_scheduled_on: '2026-11-01', installed_on: '2026-11-05', terminated_on: '2026-11-20', contract_months: 36, clawback_until: '2027-11-05', received_krw: '300000', clawback_krw: '0', clawback_risk: true, ...o });

function mk(o: { env?: Record<string, string | undefined>; staff?: StaffIdentity; tx?: (q: string) => unknown } = {}) {
  const c = { tx: 0, sql: [] as string[], vals: [] as unknown[][] };
  const d: CrmAdminDeps = {
    env: () => o.env ?? ENV, mode: () => 'supabase',
    requireStaff: async () => o.staff ?? who('owner'),
    runInTransaction: async (fn) => {
      c.tx++;
      const tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { const q = s.join('?'); c.sql.push(q); c.vals.push(v); const r = o.tx ? o.tx(q) : [row()]; if (r instanceof Error) throw r; return r; }) as never;
      return fn(tag);
    },
    now: () => new Date('2026-11-27T03:00:00Z'),
  };
  return { d, c };
}
const get = (q: string) => new Request(`http://x/api/admin/contracts?${q}`);
const j = async (r: Response) => (await r.json()) as Record<string, unknown>;
const dbErr = (message: string, code = '22023') => Object.assign(new Error(message), { code });

test('CA1 기본 닫힘·대표 외 403 — DB 0회', async () => {
  for (const env of [{}, { ...ENV, NODE_ENV: 'production' }]) {
    const { d, c } = mk({ env });
    assert.equal((await contractList(d, get('filter=all'))).status, 503);
    assert.equal(c.tx, 0);
  }
  for (const role of ['reviewer', 'counselor', 'policy_editor']) {
    const { d, c } = mk({ staff: who(role) });
    assert.equal((await contractList(d, get('filter=all'))).status, 403);
    assert.equal((await contractAction(d, { action: 'settle', leadId: LEAD, kind: 'received', amountKrw: 1, on: '2026-11-27' })).status, 403);
    assert.equal(c.tx, 0);
  }
});

test('CA2 목록: 허용 필드만·금액 숫자·위험 건수, 형태 틀린 행이면 통째로 503', async () => {
  const { d } = mk({ tx: () => [{ ...row(), extra_secret: 'x' }] });
  const r = await contractList(d, get('filter=clawback_risk'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  const b = await j(r);
  assert.equal(b.risk, 1);
  const it = (b.items as Record<string, unknown>[])[0];
  assert.equal(it.receivedKrw, 300000);
  assert.equal('extra_secret' in it, false);
  const bad = mk({ tx: () => [row(), row({ carrier: 'EVIL' })] });
  assert.equal((await contractList(bad.d, get('filter=all'))).status, 503);
});

test('CA3 목록 입력 검사: 필터 없음·형식 오류·추가 키 400, DB 0회', async () => {
  for (const q of ['', 'filter=x', 'filter=all&x=1', 'filter=all&filter=all']) {
    const { d, c } = mk();
    assert.equal((await contractList(d, get(q))).status, 400, q);
    assert.equal(c.tx, 0);
  }
});

test('CA4 일정·상태·정산: 정확한 키만, 값은 바인딩으로만 전달', async () => {
  const s = mk({ tx: () => [{ r: 'scheduled' }] });
  const r1 = await contractAction(s.d, { action: 'schedule', leadId: LEAD, carrier: 'KT', installOn: '2026-11-30', contractMonths: 36, clawbackMonths: 12 });
  assert.equal(r1.status, 201);
  assert.ok(s.c.sql[0].includes('api.contract_schedule('));
  assert.deepEqual(s.c.vals[0].slice(3), [LEAD, 'KT', '2026-11-30', 36, 12]);
  const t = mk({ tx: () => [{ r: 'clawback_risk' }] });
  assert.equal((await j(await contractAction(t.d, { action: 'status', leadId: LEAD, status: 'terminated', on: '2026-11-27' }))).result, 'clawback_risk');
  const cn = mk({ tx: () => [{ r: 'cancelled' }] });
  assert.equal((await contractAction(cn.d, { action: 'status', leadId: LEAD, status: 'cancelled' })).status, 200);
  assert.equal(cn.c.vals[0][5], null);
  const st = mk({ tx: () => [{ id: 9 }] });
  assert.equal((await contractAction(st.d, { action: 'settle', leadId: LEAD, kind: 'clawback', amountKrw: 300000, on: '2026-11-27' })).status, 201);
});

test('CA5 잘못된 입력은 DB 0회 400', async () => {
  const bad: unknown[] = [
    null, [], { action: 'schedule' }, { action: 'schedule', leadId: 'x' },
    { action: 'schedule', leadId: LEAD, carrier: 'XX', installOn: '2026-11-30', contractMonths: 36, clawbackMonths: 12 },
    { action: 'schedule', leadId: LEAD, carrier: 'KT', installOn: '2026-02-30', contractMonths: 36, clawbackMonths: 12 },
    { action: 'schedule', leadId: LEAD, carrier: 'KT', installOn: '2026-11-30', contractMonths: 36.5, clawbackMonths: 12 },
    { action: 'schedule', leadId: LEAD, carrier: 'KT', installOn: '2026-11-30', contractMonths: 36, clawbackMonths: 12, extra: 1 },
    { action: 'status', leadId: LEAD, status: 'installed' }, { action: 'status', leadId: LEAD, status: 'cancelled', on: '2026-11-27' },
    { action: 'status', leadId: LEAD, status: 'scheduled', on: '2026-11-27' },
    { action: 'settle', leadId: LEAD, kind: 'received', amountKrw: 0, on: '2026-11-27' },
    { action: 'settle', leadId: LEAD, kind: 'received', amountKrw: '300000', on: '2026-11-27' },
    { action: 'settle', leadId: LEAD, kind: 'bonus', amountKrw: 1, on: '2026-11-27' },
    { action: 'delete', leadId: LEAD },
  ];
  for (const body of bad) {
    const { d, c } = mk();
    assert.equal((await contractAction(d, body)).status, 400, JSON.stringify(body));
    assert.equal(c.tx, 0);
  }
});

test('CA6 DB 오류: 알려진 사유만 그대로, 그 밖은 원문 없이 닫힘', async () => {
  for (const [e, status, code] of [[dbErr('CONTRACT_TRANSITION'), 422, 'CONTRACT_TRANSITION'], [dbErr('LEAD_NOT_CONVERTED'), 422, 'LEAD_NOT_CONVERTED'],
    [dbErr('secret detail'), 422, 'INVALID_INPUT'], [dbErr('x', '42501'), 403, 'FORBIDDEN'], [new Error('connection to db.internal failed'), 503, 'DB_UNAVAILABLE']] as const) {
    const { d } = mk({ tx: () => e });
    const r = await contractAction(d, { action: 'status', leadId: LEAD, status: 'cancelled' });
    assert.equal(r.status, status);
    const b = await j(r);
    assert.equal(b.code, code);
    assert.equal(JSON.stringify(b).includes('db.internal'), false);
  }
});
