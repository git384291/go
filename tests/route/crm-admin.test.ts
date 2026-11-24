// PM 11/25: 날짜별 고객 관리·재연락 관리자 API 시험(CR1~CR10). 가짜 의존성만 — DB 판정 자체(동의·수신 거부·중복·대표만)는 db/tests 99_recontact_schedule·99_crm_unify가 확인.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crmAction, crmAdminReady, crmList, type CrmAdminDeps } from '../../src/server/admin/crmAdmin';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const NOW = new Date('2026-11-25T03:00:00Z'); // 한국 2026-11-25 12:00
const ENV = { ADMIN_CRM_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'secret-tok', role }) as StaffIdentity;
const LEAD = '10000000-0000-4000-8000-000000000001';
const LEAD2 = '10000000-0000-4000-8000-000000000002';
const dueRow = (o: Record<string, unknown> = {}) => ({ schedule_id: 7, lead_id: LEAD, name_masked: '홍*동', interest: 'internet_tv', channel: 'phone', due_on: '2026-11-25', overdue: false, ...o });

function mk(o: { env?: Record<string, string | undefined>; mode?: string; staff?: StaffIdentity | Error; tx?: (q: string) => unknown } = {}) {
  const c = { staff: 0, tx: 0, sql: [] as string[], vals: [] as unknown[][] };
  const d: CrmAdminDeps = {
    env: () => o.env ?? ENV, mode: () => (o.mode ?? 'supabase') as 'supabase',
    requireStaff: async () => { c.staff++; if (o.staff instanceof Error) throw o.staff; return o.staff ?? who('owner'); },
    runInTransaction: async (fn) => {
      c.tx++;
      const tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { const q = s.join('?'); c.sql.push(q); c.vals.push(v); const r = o.tx ? o.tx(q) : [dueRow()]; if (r instanceof Error) throw r; return r; }) as never;
      return fn(tag);
    },
    now: () => NOW,
  };
  return { d, c };
}
const get = (q: string) => new Request(`http://x/api/admin/crm?${q}`);
const j = async (r: Response) => (await r.json()) as Record<string, unknown>;
const dbErr = (message: string, code = '22023') => Object.assign(new Error(message), { code });

test('CR1 기본 닫힘: 스위치 없음·운영·원격 DB면 인증·DB 0회 503, 관리자 인증 꺼짐도 503', async () => {
  for (const env of [{}, { ...ENV, ADMIN_CRM_SOURCE: 'mock' }, { ...ENV, NODE_ENV: 'production' }, { ...ENV, DATABASE_URL: 'postgresql://u@db.example.com/x' }]) {
    const { d, c } = mk({ env });
    assert.equal((await crmList(d, get('view=due'))).status, 503);
    assert.equal((await crmAction(d, { action: 'sweep' })).status, 503);
    assert.deepEqual([c.staff, c.tx], [0, 0]);
    assert.equal(crmAdminReady(env), false);
  }
  const { d, c } = mk({ mode: 'off' });
  assert.equal((await crmList(d, get('view=due'))).status, 503);
  assert.equal(c.tx, 0);
});

test('CR2 권한: 무인증 401, 인증 오류 503, 대표 외(검토자·편집자·상담원) 403 — 모두 DB 0회', async () => {
  const cases: [StaffIdentity | Error, number][] = [
    [new StaffAuthError(401, 'x' as never), 401], [new StaffAuthError(403, 'x' as never), 403], [new Error('auth down'), 503],
    [who('reviewer'), 403], [who('policy_editor'), 403], [who('counselor'), 403],
  ];
  for (const [staff, status] of cases) {
    const { d, c } = mk({ staff });
    assert.equal((await crmList(d, get('view=unhandled'))).status, status);
    assert.equal((await crmAction(d, { action: 'schedule', leadId: LEAD, dueOn: '2026-11-26', channel: 'phone' })).status, status);
    assert.equal(c.tx, 0);
  }
});

test('CR3 입력 검사(DB 0회): 모르는 view·추가 키·날짜 형식·없는 날짜·unhandled에 date·미래 날짜', async () => {
  for (const q of ['view=all', '', 'view=due&x=1', 'view=due&view=due', 'view=due&date=2026-13-01', 'view=due&date=2026-02-30', 'view=due&date=20261125', 'view=unhandled&date=2026-11-25']) {
    const { d, c } = mk();
    assert.equal((await crmList(d, get(q))).status, 400, q);
    assert.equal(c.tx, 0, q);
  }
  const { d, c } = mk();
  const r = await crmList(d, get('view=due&date=2026-11-26'));
  assert.deepEqual([r.status, (await j(r)).code, c.tx], [422, 'FUTURE_DATE_UNSUPPORTED', 0]);
  const bad: unknown[] = [null, [], 'sweep', { action: 'call' }, { action: 'sweep', extra: 1 },
    { action: 'schedule', leadId: 'nope', dueOn: '2026-11-26', channel: 'phone' }, { action: 'schedule', leadId: LEAD, dueOn: '2026-11-31', channel: 'phone' },
    { action: 'schedule', leadId: LEAD, dueOn: '2026-11-26', channel: 'kakao' }, { action: 'schedule', leadId: LEAD, dueOn: '2026-11-26', channel: 'phone', phone: '01012345678' },
    { action: 'close', scheduleId: '7', status: 'done' }, { action: 'close', scheduleId: 0, status: 'done' }, { action: 'close', scheduleId: 7, status: 'blocked' }];
  for (const b of bad) {
    const m = mk();
    assert.equal((await crmAction(m.d, b)).status, 400, JSON.stringify(b));
    assert.equal(m.c.tx, 0);
  }
});

test('CR4 날짜별 조회: 오늘까지 도래한 예약 목록, date로 특정 날짜만, 값은 바인딩(문자열 이어붙이기 없음)', async () => {
  const rows = [dueRow({ schedule_id: 1, due_on: '2026-11-23', overdue: true }), dueRow({ schedule_id: 2, lead_id: LEAD2, due_on: new Date('2026-11-25T00:00:00Z') })];
  const { d, c } = mk({ tx: () => rows });
  const all = await j(await crmList(d, get('view=due')));
  assert.equal((all.items as unknown[]).length, 2);
  assert.deepEqual((all.items as { dueOn: string }[]).map((x) => x.dueOn), ['2026-11-23', '2026-11-25']);
  const one = await j(await crmList(mk({ tx: () => rows }).d, get('view=due&date=2026-11-23')));
  assert.deepEqual((one.items as { scheduleId: number }[]).map((x) => x.scheduleId), [1]);
  assert.match(c.sql[0]!, /from api\.recontact_due\(\?::uuid, \?::uuid, \?\)/);
  assert.deepEqual(c.vals[0], ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'secret-tok']);
});

test('CR5 개인정보: DB가 다른 열(전화·원문 이름·암호문)을 줘도 응답에는 허용 필드만, 긴 이름 값은 버림', async () => {
  const leak = dueRow({ phone: '010-1234-5678', name: '홍길동', phone_ct: 'AAAA', name_masked: 'x'.repeat(41) });
  const r = await crmList(mk({ tx: () => [leak] }).d, get('view=due'));
  const text = await r.text();
  for (const s of ['010-1234-5678', '홍길동', 'AAAA', 'phone_ct', '"name"', 'secret-tok']) assert.ok(!text.includes(s), s);
  const item = (JSON.parse(text) as { items: Record<string, unknown>[] }).items[0]!;
  assert.deepEqual(Object.keys(item).sort(), ['channel', 'dueOn', 'interest', 'leadId', 'nameMasked', 'overdue', 'scheduleId']);
  assert.equal(item.nameMasked, null);
});

test('CR6 형태가 틀린 DB 행이 하나라도 있으면 일부만 보여주지 않고 503', async () => {
  for (const bad of [dueRow({ channel: 'kakao' }), dueRow({ lead_id: 'x' }), dueRow({ overdue: 'yes' }), dueRow({ due_on: 'tomorrow' }), null]) {
    const r = await crmList(mk({ tx: () => [dueRow(), bad] }).d, get('view=due'));
    assert.deepEqual([r.status, (await j(r)).code], [503, 'DB_UNAVAILABLE']);
  }
  const r = await crmList(mk({ tx: () => [{ lead_id: LEAD, name_masked: '홍*동', interest: 'internet_tv', reason: 'SOMETHING', since: '2026-11-24T00:00:00Z' }] }).d, get('view=unhandled'));
  assert.equal(r.status, 503);
});

test('CR7 미처리 분류: 사유별 개수와 목록(24시간 미처리 신규·지난 재연락·미완료 후속)', async () => {
  const rows = [
    { lead_id: LEAD, name_masked: '홍*동', interest: 'internet_tv', reason: 'NEW_UNTOUCHED', since: new Date('2026-11-23T00:00:00Z') },
    { lead_id: LEAD2, name_masked: '김*수', interest: 'internet_tv', reason: 'RECONTACT_OVERDUE', since: '2026-11-22T00:00:00Z' },
    { lead_id: LEAD2, name_masked: '김*수', interest: 'internet_tv', reason: 'FOLLOWUP_OPEN', since: '2026-11-24T00:00:00Z' },
  ];
  const { d, c } = mk({ tx: () => rows });
  const b = await j(await crmList(d, get('view=unhandled')));
  assert.deepEqual(b.counts, { NEW_UNTOUCHED: 1, RECONTACT_OVERDUE: 1, FOLLOWUP_OPEN: 1 });
  assert.match(c.sql[0]!, /from api\.crm_unhandled\(/);
});

test('CR8 재연락 예약·완료·정리: 새 예약 201, 같은 날 중복은 exists 200(중복 연락 없음), 완료·정리', async () => {
  const s = mk({ tx: () => [{ r: 'scheduled' }] });
  const r1 = await crmAction(s.d, { action: 'schedule', leadId: LEAD, dueOn: '2026-11-26', channel: 'sms' });
  assert.deepEqual([r1.status, (await j(r1)).result], [201, 'scheduled']);
  assert.deepEqual(s.c.vals[0]!.slice(3), [LEAD, '2026-11-26', 'sms']);
  const r2 = await crmAction(mk({ tx: () => [{ r: 'exists' }] }).d, { action: 'schedule', leadId: LEAD, dueOn: '2026-11-26', channel: 'sms' });
  assert.deepEqual([r2.status, (await j(r2)).result], [200, 'exists']);
  assert.equal((await crmAction(mk({ tx: () => [{ r: 'weird' }] }).d, { action: 'schedule', leadId: LEAD, dueOn: '2026-11-26', channel: 'sms' })).status, 503);
  const cl = mk({ tx: () => [{}] });
  assert.equal((await crmAction(cl.d, { action: 'close', scheduleId: 7, status: 'done' })).status, 200);
  assert.match(cl.c.sql[0]!, /api\.recontact_close\(/);
  const sw = await crmAction(mk({ tx: () => [{ n: 2 }] }).d, { action: 'sweep' });
  assert.deepEqual([sw.status, (await j(sw)).blocked], [200, 2]);
});

test('CR9 DB 판정 전달: 동의 없음·수신 거부·대기 3건 초과·없는 고객·이미 처리 → 422 고정 코드, 권한 42501 → 403, 그 밖은 원문 없이 503', async () => {
  for (const m of ['NO_CONSENT', 'OPTED_OUT', 'TOO_MANY_PENDING', 'LEAD_NOT_FOUND', 'NOT_PENDING']) {
    const r = await crmAction(mk({ tx: () => dbErr(m) }).d, { action: 'schedule', leadId: LEAD, dueOn: '2026-11-26', channel: 'phone' });
    assert.deepEqual([r.status, (await j(r)).code], [422, m]);
  }
  const f = await crmAction(mk({ tx: () => dbErr('FORBIDDEN', '42501') }).d, { action: 'sweep' });
  assert.equal(f.status, 403);
  const x = await crmList(mk({ tx: () => dbErr('connection refused host=db.internal password=hunter2', '08006') }).d, get('view=due'));
  const t = await x.text();
  assert.equal(x.status, 503);
  for (const s of ['db.internal', 'hunter2', 'connection']) assert.ok(!t.includes(s));
  const y = await crmAction(mk({ tx: () => dbErr('SOMETHING_ELSE detail') }).d, { action: 'sweep' });
  assert.deepEqual([y.status, (await j(y)).code], [422, 'INVALID_INPUT']);
});

test('CR10 정적: 실제 발신 코드 없음(fetch·SMS·알림톡·전화 SDK), 응답은 no-store, 라우트는 staff 역할·대표 전용 모듈 연결', () => {
  const src = readFileSync('src/server/admin/crmAdmin.ts', 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  for (const bad of [/fetch\(/, /twilio|aligo|solapi|kakao/i, /sendSms|sendAlimtalk|dial\(/i, /process\.env/, /console\./]) assert.ok(!bad.test(src), String(bad));
  assert.match(src, /'Cache-Control': 'private, no-store'/);
  assert.match(src, /who\.role !== 'owner'/);
  const route = readFileSync('src/app/api/admin/crm/route.ts', 'utf8');
  assert.match(route, /withRole\('staff'/);
  assert.match(route, /crmList\(deps\(\), req\)/);
  assert.match(route, /crmAction\(deps\(\), body\)/);
});
