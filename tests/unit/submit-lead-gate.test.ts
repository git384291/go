// PM 11/21: 접수 직전 서버가 DB 게이트(api.notice_intake_gate)를 먼저 호출하고, 게이트 거절은 저장 없이 503으로 닫는지 시험(가짜 실행기).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { noticeHashes, submitLead } from '../../src/server/leads/submitLead';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';

const ctx = {
  crypto: createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: Buffer.alloc(32, 4) }),
  signingKey: { keyId: 1, secret: Buffer.alloc(32, 0x22) },
  currentPrivacyVersion: 'privacy-test-v1', clientIp: '203.0.113.10', nowSeconds: 1_800_000_000,
  notices: { version: 'privacy-test-v1', confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: ' 시험용 문구 ' }] },
};
const lead = { name: '테스트고객', phone: '010-0000-0001', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['n1'], noticeHashes: noticeHashes(ctx.notices), idempotencyKey: 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab' };

function runner(failOn?: { sql: RegExp; err: unknown }) {
  const calls: { q: string; v: unknown[] }[] = [];
  const run = async (fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => PromiseLike<unknown>) =>
    fn((s, ...v) => { const q = s.join('?'); calls.push({ q, v }); if (failOn && failOn.sql.test(q)) throw failOn.err; return Promise.resolve([]); });
  return { run, calls };
}

test('SG1 접수는 게이트 호출이 먼저, 그 다음 create_lead(같은 실행기). 게이트에는 서버 상수의 버전·문구 해시를 보낸다', async () => {
  const { run, calls } = runner();
  assert.deepEqual(await submitLead(lead, ctx, run), { ok: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].q, /api\.notice_intake_gate/);
  assert.match(calls[1].q, /api\.create_lead/);
  const sha = createHash('sha256').update('시험용 문구', 'utf8').digest('hex');
  assert.deepEqual(calls[0].v, ['privacy-test-v1', JSON.stringify({ n1: sha })]);
  assert.deepEqual(noticeHashes(ctx.notices), { n1: sha });
});

test('SG2 게이트가 거절하면 create_lead를 호출하지 않고 503과 사유 코드(문구 없음)로 닫는다', async () => {
  for (const c of ['NOTICE_NOT_APPROVED', 'NOTICE_CHANGED', 'NOTICE_HASH_MISMATCH', 'NOTICE_KEYS_MISMATCH', 'NOTICE_VERSION_MISMATCH', 'NOTICE_NOT_FOUND', 'NOTICE_SELF_APPROVED', 'NOTICE_INVALID']) {
    const { run, calls } = runner({ sql: /notice_intake_gate/, err: Object.assign(new Error(c), { code: '55000' }) });
    assert.deepEqual(await submitLead(lead, ctx, run), { ok: false, code: c, status: 503 }, c);
    assert.equal(calls.some((x) => /create_lead/.test(x.q)), false, c);
  }
});

test('SG3 알 수 없는 55000은 SERVICE_NOT_READY, 실제 설정(미확정)은 DB를 한 번도 부르지 않는다', async () => {
  const a = runner({ sql: /notice_intake_gate/, err: Object.assign(new Error('SOMETHING'), { code: '55000' }) });
  assert.deepEqual(await submitLead(lead, ctx, a.run), { ok: false, code: 'SERVICE_NOT_READY', status: 503 });
  const { notices: _omit, ...real } = ctx;
  const b = runner();
  assert.deepEqual(await submitLead(lead, real, b.run), { ok: false, code: 'NOTICE_NOT_CONFIRMED', status: 503 });
  assert.equal(b.calls.length, 0);
});

const APP = { carrier: 'carrier-x', productId: 'p1', regionCode: 'r1', installAddress: '서울시 가상구 시험로 12 101동 1203호', phoneCarrier: 'kt', email: 'test@example.com', currentCarrier: 'kt', installPref: 'asap', existingLine: 'has', ack12m: 'confirmed', ackContract3y: 'confirmed' };

test('SG4 신청서가 있으면 같은 실행기(한 트랜잭션)에서 게이트 → create_lead → application_save 순서, 본문은 암호문·요약엔 주소 없음', async () => {
  let runs = 0;
  const calls: { q: string; v: unknown[] }[] = [];
  const run = async (fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => PromiseLike<unknown>) => { runs++; return fn((s, ...v) => { calls.push({ q: s.join('?'), v }); return Promise.resolve([]); }); };
  assert.deepEqual(await submitLead({ ...lead, application: APP }, ctx, run), { ok: true });
  assert.equal(runs, 1);
  assert.deepEqual(calls.map((c) => /notice_intake_gate/.test(c.q) ? 'gate' : /create_lead/.test(c.q) ? 'lead' : /application_save/.test(c.q) ? 'app' : '?'), ['gate', 'lead', 'app']);
  const [, , payloadEnc, summary] = calls[2].v as string[];
  assert.match(payloadEnc, /^v1:/);
  assert.equal(payloadEnc.includes('시험로'), false);
  assert.equal(summary.includes('시험로'), false);
  assert.equal(JSON.parse(summary).missing.length, 0);
});

test('SG5 신청서에 주민번호·계좌 등이 있거나 형식이 틀리면 DB 호출 없이 400, 저장 실패는 접수 전체 실패(한 트랜잭션)', async () => {
  for (const bad of [{ ...APP, memo: '주민번호 900101-1234567' }, { ...APP, installAddress: '110-123-456789' }, { ...APP, existingLine: 'maybe' }, { ...APP, extra: 'x' }]) {
    const { run, calls } = runner();
    const r = await submitLead({ ...lead, application: bad }, ctx, run);
    assert.equal(r.ok, false);
    assert.ok(['SENSITIVE_INPUT', 'APPLICATION_INVALID'].includes((r as { code: string }).code));
    assert.equal(calls.length, 0);
  }
  const fail = runner({ sql: /application_save/, err: Object.assign(new Error('INVALID_INPUT'), { code: '22023' }) });
  assert.deepEqual(await submitLead({ ...lead, application: APP }, ctx, fail.run), { ok: false, code: 'INVALID_INPUT', status: 400 });
});

test('SG6 롤백 불일치는 닫힌 채 실패: 0016(게이트 함수)·0017(application_save)이 없으면 500, 접수 전체 롤백(저장 시도만 있고 성공 응답 없음)', async () => {
  for (const missing of [/notice_intake_gate/, /application_save/]) {
    const fail = runner({ sql: missing, err: Object.assign(new Error('function does not exist'), { code: '42883' }) });
    const r = await submitLead({ ...lead, application: APP }, ctx, fail.run);
    assert.deepEqual(r, { ok: false, code: 'INTERNAL', status: 500 });
  }
});

test('SG7 고객 화면이 보여 준 문구 해시가 서버 상수와 다르거나 없거나 남으면 DB 호출 없이 503(NOTICE_HASH_MISMATCH)·형식 오류는 400', async () => {
  const h = noticeHashes(ctx.notices);
  for (const bad of [{ n1: 'f'.repeat(64) }, {}, { ...h, extra: h.n1 }, { n2: h.n1 }]) {
    const { run, calls } = runner();
    assert.deepEqual(await submitLead({ ...lead, noticeHashes: bad }, ctx, run), { ok: false, code: 'NOTICE_HASH_MISMATCH', status: 503 });
    assert.equal(calls.length, 0);
  }
  for (const bad of [undefined, { n1: 'xyz' }, 'x']) {
    const { run, calls } = runner();
    const r = await submitLead({ ...lead, noticeHashes: bad }, ctx, run);
    assert.deepEqual(r, { ok: false, code: 'INVALID_INPUT', status: 400 });
    assert.equal(calls.length, 0);
  }
});
