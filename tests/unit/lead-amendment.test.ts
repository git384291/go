// PM 11/22 P1: 같은 연락처 재접수 — 같은 내용은 저장 없음(already), 다른 내용은 변경 요청(amended). 원본 덮어쓰기 없음. 가짜 실행기만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { submitLead, noticeHashes } from '../../src/server/leads/submitLead';
import { applicationContentHmac, buildCreateLeadArgs } from '../../src/server/leads/intake';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import { classifyResponse, isAcceptedKind, OUTCOME_MESSAGES } from '../../src/components/consultSubmit';

const NOTICES = { version: 'privacy-test-v1', confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: '시험용 문구' }] };
const crypto = createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: Buffer.alloc(32, 4) });
const ctx = { crypto, signingKey: { keyId: 1, secret: Buffer.alloc(32, 0x22) }, currentPrivacyVersion: 'privacy-test-v1', clientIp: '203.0.113.10', nowSeconds: 1_800_000_000, notices: NOTICES };
const APP = { carrier: 'carrier-x', productId: 'p1', regionCode: 'r1', installAddress: '서울시 가상구 시험로 12 101동 1203호', phoneCarrier: 'kt', email: 'test@example.com' };
const lead = (app: Record<string, string>, key = 'amend-unit-000000001') => ({ name: '테스트고객', phone: '010-0000-0001', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['n1'], noticeHashes: noticeHashes(NOTICES), idempotencyKey: key, application: app });
const runner = (save: string, amend?: string) => {
  const qs: string[] = [];
  const run = async (fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => PromiseLike<unknown>) =>
    fn((s) => { const q = s.join('?'); qs.push(q); return Promise.resolve(/application_save/.test(q) ? [{ r: save }] : /application_amend/.test(q) ? [{ r: amend }] : []); });
  return { run, qs };
};

test('LA1 새 접수(saved)·재접수(skipped) 모두 같은 트랜잭션에서 같은 순서로 application_amend까지 호출(응답 시간 차이 축소), 내부 결과만 created / already / amended', async () => {
  const order = (qs: string[]) => qs.map((q) => (/notice_intake_gate/.test(q) ? 'gate' : /create_lead/.test(q) ? 'lead' : /application_save/.test(q) ? 'save' : /application_amend/.test(q) ? 'amend' : '?'));
  for (const [save, r, want] of [['saved', 'same', 'created'], ['saved', 'amended', 'created'], ['skipped', 'same', 'already'], ['skipped', 'amended', 'amended'], ['skipped', 'skipped', 'created']] as const) {
    const k = runner(save, r);
    assert.deepEqual(await submitLead(lead(APP), ctx, k.run), { ok: true, outcome: want });
    assert.deepEqual(order(k.qs), ['gate', 'lead', 'save', 'amend']);
  }
  const e = runner('exists');
  assert.deepEqual(await submitLead(lead(APP), ctx, e.run), { ok: true, outcome: 'created' });
  assert.deepEqual(order(e.qs), ['gate', 'lead', 'save']);
});
test('LA2 내용 해시: 같은 내용·키 순서 무관 같음, 한 항목만 달라도 다름, 연락처(솔트)가 다르면 다름. 요약에 해시만(주소·이메일 원문 없음)', () => {
  const h = (app: Record<string, string>, salt = 'a'.repeat(64)) => applicationContentHmac(crypto, salt, app);
  assert.equal(h(APP), h(Object.fromEntries(Object.entries(APP).reverse())));
  assert.notEqual(h(APP), h({ ...APP, installAddress: '서울시 가상구 시험로 99 202동 101호' }));
  assert.notEqual(h(APP), h({ ...APP, phoneCarrier: 'skt' }));
  assert.notEqual(h(APP), h(APP, 'b'.repeat(64)));
  const a = buildCreateLeadArgs(lead(APP), ctx).application!;
  const sum = JSON.parse(a.summary) as Record<string, unknown>;
  assert.match(String(sum.contentHmac), /^[0-9a-f]{64}$/);
  assert.equal(sum.contentHmac, a.amendment.contentHmac);
  assert.ok(!/가상구|example\.com/.test(a.summary));
  assert.match(a.payloadEnc, /^v1:/);
});
test('LA3 고객 문구: 202면 본문(outcome 등)과 무관하게 같은 접수 문구 하나(새 접수·같은 내용 재접수·변경 요청 구분 없음 — 연락처 존재 여부 추측 방지)', () => {
  const kinds = [{ ok: true }, { ok: true, outcome: 'already' }, { ok: true, outcome: 'amended' }, { outcome: 'weird' }, null].map((b) => classifyResponse(202, b));
  for (const k of kinds) assert.deepEqual(k, { kind: 'accepted', message: OUTCOME_MESSAGES.accepted, retryable: false });
  assert.ok(isAcceptedKind('accepted'));
  assert.ok(!('already' in OUTCOME_MESSAGES) && !('amended' in OUTCOME_MESSAGES));
});
test('LA4 접수 API 응답 본문: 성공은 항상 {ok:true} 202 하나(내부 결과 created/already/amended를 내보내지 않음)', () => {
  const src = readFileSync('src/app/api/leads/route.ts', 'utf8');
  assert.match(src, /const accepted = \(\) => NextResponse\.json\(\{ ok: true \}, \{ status: 202 \}\)/);
  assert.ok(!/outcome/.test(src.replace(/^\s*\/\/.*$/gm, '')));
});
