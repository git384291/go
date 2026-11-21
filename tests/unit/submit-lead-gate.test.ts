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
const lead = { name: '테스트고객', phone: '010-0000-0001', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['n1'], idempotencyKey: 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab' };

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
