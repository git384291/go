import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../../src/server/security/token';
import { createPiiCrypto, maskName, normalizeMobile, PiiCryptoError } from '../../src/server/security/piiCrypto';
import { staffAssertion, staffSessionOpenAssertion, StaffAuthError } from '../../src/server/auth/staffAssertion';

const KEY = { keyId: 1, secret: Buffer.alloc(32, 0x11) };
const NOW = 1_800_000_000;

test('T1 서명 토큰: 같은 입력이면 같은 토큰, 형식은 <kid>.<exp>.<64hex>', () => {
  const a = signToken('staff', ['x', 'y'], KEY, NOW);
  assert.equal(a, signToken('staff', ['x', 'y'], KEY, NOW));
  assert.match(a, /^1\.1800000120\.[0-9a-f]{64}$/);
});

test('T2 서명 토큰: 필드 경계를 옮겨도 같은 서명이 나오지 않는다', () => {
  assert.notEqual(signToken('lead', ['a|b', 'c'], KEY, NOW), signToken('lead', ['a', 'b|c'], KEY, NOW));
  assert.notEqual(signToken('lead', ['ab', ''], KEY, NOW), signToken('lead', ['a', 'b'], KEY, NOW));
});

test('T3 서명 토큰: 용도가 다르면 다른 서명', () => {
  assert.notEqual(signToken('lead', ['x'], KEY, NOW).split('.')[2], signToken('staff', ['x'], KEY, NOW).split('.')[2]);
});

test('T4 서명 키가 32바이트 미만이면 거부', () => {
  assert.throws(() => signToken('lead', ['x'], { keyId: 1, secret: Buffer.alloc(16) }, NOW));
});

const crypto = createPiiCrypto({
  encKeys: { '1': Buffer.alloc(32, 1), '2': Buffer.alloc(32, 2) },
  currentVersion: '2',
  hmacKey: Buffer.alloc(32, 3),
  ipHashKey: Buffer.alloc(32, 4),
});

test('T5 암호화 왕복, 매번 다른 암호문, 현재 키 버전 표시', () => {
  const c1 = crypto.encrypt('테스트고객');
  const c2 = crypto.encrypt('테스트고객');
  assert.notEqual(c1, c2);
  assert.match(c1, /^v2:/);
  assert.equal(crypto.decrypt(c1), '테스트고객');
});

test('T6 이전 키 버전 암호문도 복호화', () => {
  const old = createPiiCrypto({
    encKeys: { '1': Buffer.alloc(32, 1) },
    currentVersion: '1',
    hmacKey: Buffer.alloc(32, 3),
    ipHashKey: Buffer.alloc(32, 4),
  }).encrypt('01000000001');
  assert.equal(crypto.decrypt(old), '01000000001');
});

test('T7 변조된 암호문은 인증 태그 오류', () => {
  const c = crypto.encrypt('01000000001').split(':');
  const ct = Buffer.from(c[3], 'base64');
  ct[0] ^= 0xff;
  assert.throws(() => crypto.decrypt([c[0], c[1], c[2], ct.toString('base64')].join(':')));
});

test('T8 전화번호 정규화와 HMAC: 표기가 달라도 같은 해시', () => {
  assert.equal(normalizeMobile('010-0000-0001'), '01000000001');
  assert.equal(normalizeMobile('+82 10 0000 0001'), '01000000001');
  assert.equal(crypto.phoneHmac(normalizeMobile('010 0000 0001')), crypto.phoneHmac('01000000001'));
  assert.throws(() => normalizeMobile('02-123-4567'), PiiCryptoError);
});

test('T9 이름 마스킹', () => {
  assert.equal(maskName('홍길동'), '홍*동');
  assert.equal(maskName('김철'), '김*');
  assert.equal(maskName('남궁민수'), '남**수');
});

const OWNER = '00000000-0000-4000-8000-000000000001';
const SESSION = '10000000-0000-4000-8000-000000000001';

test('T10 관리자 인증: 2단계 인증(aal2) 아니면 거부', () => {
  assert.throws(() => staffAssertion({ sub: OWNER, session_id: SESSION, aal: 'aal1' }, KEY, NOW), (e) =>
    e instanceof StaffAuthError && e.message === 'MFA_REQUIRED');
});

test('T11 관리자 인증: 사용자·세션 ID 없거나 형식 오류면 거부', () => {
  assert.throws(() => staffAssertion({ session_id: SESSION, aal: 'aal2' }, KEY, NOW), StaffAuthError);
  assert.throws(() => staffAssertion({ sub: OWNER, aal: 'aal2' }, KEY, NOW), StaffAuthError);
  assert.throws(() => staffAssertion({ sub: "x' or 1=1--", session_id: SESSION, aal: 'aal2' }, KEY, NOW), StaffAuthError);
});

test('T12 관리자 인증: 사용자와 세션을 함께 서명, 세션 열기 토큰과 일반 토큰은 서로 다르다', () => {
  const a = staffAssertion({ sub: OWNER, session_id: SESSION, aal: 'aal2' }, KEY, NOW);
  const o = staffSessionOpenAssertion({ sub: OWNER, session_id: SESSION, aal: 'aal2' }, KEY, NOW);
  assert.equal(a.token, signToken('staff', [OWNER, SESSION], KEY, NOW));
  assert.notEqual(a.token, o.token);
});
