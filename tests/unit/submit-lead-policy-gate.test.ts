// PM 11/24 결정: 유효한 게시 정책이 없거나 정책 검증 장애(B)면 서버가 접수 트랜잭션 안에서 저장 전에 취소하는지 시험(가짜 실행기, 실제 DB는 db/tests/99_policy_intake_gate.sql·db-test.sh PG6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeHashes, submitLead } from '../../src/server/leads/submitLead';
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
const KEY = { supplierId: 'supplier-a', carrier: 'carrier-x', productId: 'net500-tv-basic' };
const pol = (verdict: (rows: readonly unknown[]) => Promise<string | null>, key: typeof KEY | null = KEY) => ({ policy: { key, verdict } });

test('PI1 [필수1·2·6] 정책 없음(스위치 OFF 포함)·검증 장애면 고지 게이트 → 정책 게이트 → 재조회 뒤 저장 호출 0, 503', async () => {
  for (const code of ['POLICY_NOT_PUBLISHED', 'POLICY_UNVERIFIED']) {
    for (const body of [lead, { ...lead, application: APP }]) {
      const r = runner(() => [{ any: 1 }]);
      const seen: unknown[][] = [];
      const res = await submitLead(body, { ...ctx, ...pol(async (rows) => { seen.push([...rows]); return code; }) }, r.run);
      assert.deepEqual(res, { ok: false, code, status: 503 });
      assert.deepEqual(kinds(r.calls), ['notice', 'pgate', 'policy']);
      assert.deepEqual(r.calls[1].v, ['supplier-a', 'carrier-x', 'net500-tv-basic'], 'DB 게이트에는 서버 설정 키');
      assert.equal(r.runs(), 1, '한 트랜잭션');
      assert.ok(!kinds(r.calls).some((k) => SAVES.has(k)), '리드·신청서·변경요청·연락동의 저장 없음');
      assert.deepEqual(seen, [[{ any: 1 }]], '판정은 같은 트랜잭션에서 읽은 행으로');
    }
  }
});

test('PI2 [필수3] 유효 정책(판정 null)이면 기존 순서로 저장, 정책 검사 미설정 경로는 기존 동작 그대로', async () => {
  const ok = runner();
  assert.deepEqual(await submitLead({ ...lead, application: APP }, { ...ctx, ...pol(async () => null) }, ok.run), { ok: true, outcome: 'created' });
  assert.deepEqual(kinds(ok.calls), ['notice', 'pgate', 'policy', 'lead', 'app']);
  const legacy = runner();
  assert.deepEqual(await submitLead(lead, ctx, legacy.run), { ok: true, outcome: 'created' });
  assert.deepEqual(kinds(legacy.calls), ['notice', 'lead']);
});

test('PI3 [필수5] DB 게이트 거절(스위치 OFF·정책 없음·충돌)·조회 실패·판정 예외·키 미설정은 모두 저장 없이 닫힌다', async () => {
  for (const code of ['POLICY_PUBLISH_OFF', 'POLICY_NOT_PUBLISHED', 'POLICY_UNVERIFIED']) {
    const g = runner(() => [], { sql: /policy_intake_gate/, err: Object.assign(new Error(code), { code: '55000' }) });
    assert.deepEqual(await submitLead(lead, { ...ctx, ...pol(async () => null) }, g.run), { ok: false, code, status: 503 }, code);
    assert.ok(!kinds(g.calls).some((k) => SAVES.has(k)), code);
  }
  const down = runner(() => [], { sql: /policy_published/, err: Object.assign(new Error('connection refused'), { code: '08006' }) });
  assert.equal((await submitLead(lead, { ...ctx, ...pol(async () => null) }, down.run)).ok, false);
  assert.ok(!kinds(down.calls).some((k) => SAVES.has(k)));
  const thrower = runner();
  assert.equal((await submitLead(lead, { ...ctx, ...pol(async () => { throw new Error('x'); }) }, thrower.run)).ok, false);
  assert.ok(!kinds(thrower.calls).some((k) => SAVES.has(k)));
  const nokey = runner();
  assert.deepEqual(await submitLead(lead, { ...ctx, ...pol(async () => null, null) }, nokey.run), { ok: false, code: 'POLICY_NOT_PUBLISHED', status: 503 });
  assert.ok(!kinds(nokey.calls).some((k) => SAVES.has(k)), '키 미설정: 저장 없음');
});

test('PI4 [필수4] 정책 변경과 접수 동시 요청: 게이트(공유 잠금) 뒤 같은 트랜잭션에서 읽은 상태로만 판정', async () => {
  const st: { v: 'ok' | 'gone' } = { v: 'ok' };
  const verdict = async (rows: readonly unknown[]) => (rows.length === 1 ? null : 'POLICY_NOT_PUBLISHED');
  const a = runner(() => (st.v === 'ok' ? [{ v: 1 }] : []));
  assert.equal((await submitLead(lead, { ...ctx, ...pol(verdict) }, a.run)).ok, true);
  st.v = 'gone';
  const b = runner(() => (st.v === 'ok' ? [{ v: 1 }] : []));
  assert.deepEqual(await submitLead(lead, { ...ctx, ...pol(verdict) }, b.run), { ok: false, code: 'POLICY_NOT_PUBLISHED', status: 503 });
  const order = kinds(b.calls);
  assert.ok(order.indexOf('pgate') < order.indexOf('policy'), '잠금 게이트가 재조회보다 먼저');
});

test('PI5 화면: 서버 정책 차단 코드 3종은 모두 B 안내(재시도 없음), 과장 약속·숫자 없음', () => {
  for (const code of ['POLICY_UNVERIFIED', 'POLICY_NOT_PUBLISHED', 'POLICY_PUBLISH_OFF']) {
    assert.deepEqual(classifyResponse(503, { ok: false, code }), { kind: 'policy', message: POLICY_UNVERIFIED_GUIDANCE, retryable: false }, code);
  }
  assert.equal(OUTCOME_MESSAGES.policy, POLICY_UNVERIFIED_GUIDANCE);
  assert.ok(!/\d/.test(POLICY_UNVERIFIED_GUIDANCE));
});
