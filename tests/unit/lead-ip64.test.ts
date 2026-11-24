// PM 11/24: /api/leads IP별 접수 한도 키도 IPv6 /64 단위(주소 바꾸기 우회 방지). IPv4는 기존과 같은 값(정상 고객 영향 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noticeHashes, submitLead } from '../../src/server/leads/submitLead';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';

const crypto = createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: Buffer.alloc(32, 4) });
const notices = { version: 'privacy-test-v1', confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: ' 시험용 문구 ' }] };
const base = { crypto, signingKey: { keyId: 1, secret: Buffer.alloc(32, 0x22) }, currentPrivacyVersion: 'privacy-test-v1', nowSeconds: 1_800_000_000, notices };
const lead = { name: '테스트고객', phone: '010-0000-0001', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['n1'], noticeHashes: noticeHashes(notices), idempotencyKey: 'lead-ip64-test-0001' };

async function sentIpHash(clientIp: string): Promise<unknown> {
  const calls: { q: string; v: unknown[] }[] = [];
  const run = async (fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => PromiseLike<unknown>) =>
    fn((s, ...v) => { calls.push({ q: s.join('?'), v }); return Promise.resolve([]); });
  assert.deepEqual(await submitLead(lead, { ...base, clientIp }, run), { ok: true, outcome: 'created' });
  const c = calls.find((x) => /api\.create_lead/.test(x.q))!;
  return c.v.at(-1);
}

test('LI1 IPv4는 기존과 같은 해시(정상 고객 한도·기록 변화 없음), 서로 다른 IPv4는 따로', async () => {
  assert.equal(await sentIpHash('203.0.113.10'), crypto.ipHash('203.0.113.10'));
  assert.notEqual(await sentIpHash('203.0.113.11'), await sentIpHash('203.0.113.10'));
});

test('LI2 같은 /64 안의 IPv6 주소는 한 버킷(주소 바꾸기 우회 불가), 다른 /64는 따로(과잉 차단 없음), 원문 IP 미전송', async () => {
  const a = await sentIpHash('2001:db8:1:2::1');
  assert.equal(a, crypto.ipHash('2001:db8:1:2::/64'));
  for (const ip of ['2001:db8:1:2::ffff', '2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd']) assert.equal(await sentIpHash(ip), a, ip);
  assert.notEqual(await sentIpHash('2001:db8:1:3::1'), a);
  assert.match(String(a), /^[0-9a-f]{64}$/);
});

test('LI3 배선(정적): 접수 IP 해시는 rateLimitIpKey를 거친다, 봇 확인은 원래 IP', () => {
  assert.match(readFileSync('src/server/leads/intake.ts', 'utf8'), /ipHash\(rateLimitIpKey\(ctx\.clientIp\)\)/);
  assert.match(readFileSync('src/app/api/leads/route.ts', 'utf8'), /verifyTurnstile\([^;]*, ip\)/);
});
