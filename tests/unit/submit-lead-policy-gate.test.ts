// PM 11/24 추가 지시: 정책 검증 장애(B)면 서버가 접수 트랜잭션 안에서 저장 전에 취소하는지 시험(가짜 실행기, 실제 DB는 db/tests/99_policy_intake_gate.sql·db-test.sh PG6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLead } from '../../src/server/leads/submitLead';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import { classifyResponse, OUTCOME_MESSAGES } from '../../src/components/consultSubmit';
import { POLICY_UNVERIFIED_GUIDANCE } from '../../src/content/consultGuidance';

const ctx = {
  crypto: createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: Buffer.alloc(32, 4) }),
  signingKey: { keyId: 1, secret: Buffer.alloc(32, 0x22) },
  currentPrivacyVersion: 'privacy-test-v1', clientIp: '203.0.113.10', nowSeconds: 1_800_000_000,
  notices: { version: 'privacy-test-v1', confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: ' 시험용 문구 ' }] },
};
const lead = { name: '테스트고객', phone: '010-0000-0001', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['n1'], noticeHashes: noticeHashes(ctx.notices), idempotencyKey: 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab' };
const APP = { carrier: 'carrier-x', productId: 'p1', regionCode: 'r1', installAddress: '서울시 가상구 시험로 12 101동 1203호', phoneCarrier: 'kt', email: 'test@example.com', currentCarrier: 'kt', installPref: 'asap', existingLine: 'has', ack12m: 'confirmed', ackContract3y: 'confirmed' };

type Call = { q: string; v: unknown[] };
/** 한 트랜잭션 가짜 실행기. policy_published는 rowsOf()가 돌려주는 행(트랜잭션 안에서 읽는 그 순간의 정책 상태)을 준다 */
function runner(rowsOf: () => unknown[] = () => [], failOn?: { sql: RegExp; err: unknown }) {
  const calls: Call[] = [];
  let runs = 0;
  const run = async (fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => PromiseLike<unknown>) => {
    runs++;
    return fn((s, ...v) => {
      const q = s.join('?'); calls.push({ q, v });
      if (failOn && failOn.sql.test(q)) throw failOn.err;
      return Promise.resolve(/policy_published/.test(q) ? rowsOf().map((p) => ({ p })) : []);
    });
  };
  return { run, calls, runs: () => runs };
}
const kinds = (calls: Call[]) => calls.map((c) => /notice_intake_gate/.test(c.q) ? 'notice' : /policy_intake_gate/.test(c.q) ? 'pgate' : /policy_published/.test(c.q) ? 'policy' : /create_lead/.test(c.q) ? 'lead' : /application_save/.test(c.q) ? 'app' : /application_amend/.test(c.q) ? 'amend' : /followup_request/.test(c.q) ? 'followup' : '?');
const SAVES = new Set(['lead', 'app', 'amend', 'followup']);

test('PI1 정책 검증 장애면 고지 게이트 → 정책 게이트 → 정책 재조회 뒤 저장 호출 0, 503 POLICY_UNVERIFIED', async () => {
  for (const body of [lead, { ...lead, application: APP }]) {
    const r = runner(() => [{ any: 1 }]);
    const seen: unknown[][] = [];
    const res = await submitLead(body, { ...ctx, policyFault: async (rows) => { seen.push([...rows]); return true; } }, r.run);
    assert.deepEqual(res, { ok: false, code: 'POLICY_UNVERIFIED', status: 503 });
    assert.deepEqual(kinds(r.calls), ['notice', 'pgate', 'policy']);
    assert.equal(r.runs(), 1, '한 트랜잭션');
    assert.ok(!kinds(r.calls).some((k) => SAVES.has(k)), '리드·신청서·변경요청·연락동의 저장 없음');
    assert.deepEqual(seen, [[{ any: 1 }]], '판정기는 같은 트랜잭션에서 읽은 행을 받는다');
  }
});

test('PI2 정상(장애 아님)이면 기존 순서 그대로 저장, 판정기 없으면 정책 호출 자체가 없다(기존 동작 유지)', async () => {
  const ok = runner();
  assert.deepEqual(await submitLead({ ...lead, application: APP }, { ...ctx, policyFault: async () => false }, ok.run), { ok: true, outcome: 'created' });
  assert.deepEqual(kinds(ok.calls), ['notice', 'pgate', 'policy', 'lead', 'app']);
  const legacy = runner();
  assert.deepEqual(await submitLead(lead, ctx, legacy.run), { ok: true, outcome: 'created' });
  assert.deepEqual(kinds(legacy.calls), ['notice', 'lead']);
});

test('PI3 DB 정책 게이트 거절(충돌 POLICY_UNVERIFIED)·조회 실패·비배열 응답은 모두 저장 없이 닫힌다', async () => {
  const conflict = runner(() => [], { sql: /policy_intake_gate/, err: Object.assign(new Error('POLICY_UNVERIFIED'), { code: '55000' }) });
  assert.deepEqual(await submitLead(lead, { ...ctx, policyFault: async () => false }, conflict.run), { ok: false, code: 'POLICY_UNVERIFIED', status: 503 });
  assert.ok(!kinds(conflict.calls).some((k) => SAVES.has(k)));
  const down = runner(() => [], { sql: /policy_published/, err: Object.assign(new Error('connection refused'), { code: '08006' }) });
  const d = await submitLead(lead, { ...ctx, policyFault: async () => false }, down.run);
  assert.equal(d.ok, false);
  assert.ok(!kinds(down.calls).some((k) => SAVES.has(k)));
  // 판정기 자체가 예외면 저장하지 않는다(fail-closed)
  const thrower = runner();
  const t = await submitLead(lead, { ...ctx, policyFault: async () => { throw new Error('x'); } }, thrower.run);
  assert.equal(t.ok, false);
  assert.ok(!kinds(thrower.calls).some((k) => SAVES.has(k)));
});

test('PI4 정책 변경과 접수 동시 요청: 판정은 게이트(공유 잠금) 뒤 같은 트랜잭션에서 읽은 상태로만 한다', async () => {
  // 트랜잭션 밖에서 정책이 바뀌어도(게이트 뒤 읽은 순간의 값) 그 값으로 판정. 장애 상태로 바뀐 직후의 접수는 저장 없이 닫힌다
  let state: 'ok' | 'conflict' = 'ok';
  const r = runner(() => (state === 'conflict' ? [{ v: 1 }, { v: 2 }] : [{ v: 1 }]));
  const fault = async (rows: readonly unknown[]) => rows.length > 1;
  assert.equal((await submitLead(lead, { ...ctx, policyFault: fault }, r.run)).ok, true);
  state = 'conflict';
  const r2 = runner(() => (state === 'conflict' ? [{ v: 1 }, { v: 2 }] : [{ v: 1 }]));
  assert.deepEqual(await submitLead(lead, { ...ctx, policyFault: fault }, r2.run), { ok: false, code: 'POLICY_UNVERIFIED', status: 503 });
  const order = kinds(r2.calls);
  assert.ok(order.indexOf('pgate') < order.indexOf('policy'), '잠금 게이트가 재조회보다 먼저');
});

test('PI5 화면: 서버 POLICY_UNVERIFIED는 B 안내(재시도 없음), 과장 약속 없음', () => {
  const o = classifyResponse(503, { ok: false, code: 'POLICY_UNVERIFIED' });
  assert.deepEqual(o, { kind: 'policy', message: POLICY_UNVERIFIED_GUIDANCE, retryable: false });
  assert.equal(OUTCOME_MESSAGES.policy, POLICY_UNVERIFIED_GUIDANCE);
  assert.ok(!/\d/.test(POLICY_UNVERIFIED_GUIDANCE));
});
