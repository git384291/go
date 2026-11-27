import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateLeadArgs, leadIntakeGate, LeadRejected, leadSignedFields, noticeHashes } from '../../src/server/leads/intake';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import { signToken } from '../../src/server/security/token';

const ctx = {
  crypto: createPiiCrypto({
    encKeys: { '1': Buffer.alloc(32, 1) },
    currentVersion: '1',
    hmacKey: Buffer.alloc(32, 3),
    ipHashKey: Buffer.alloc(32, 4),
  }),
  signingKey: { keyId: 1, secret: Buffer.alloc(32, 0x22) },
  currentPrivacyVersion: 'privacy-test-v1',
  clientIp: '203.0.113.10',
  nowSeconds: 1_800_000_000,
  // 시험 전용 확정 문구(실제 문구 아님). 실제 설정(REQUIRED_NOTICES)은 미확정이라 접수를 거부한다(아래 IN1)
  notices: { version: 'privacy-test-v1', confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: '시험용 문구' }] },
};

const valid = {
  name: '테스트고객',
  phone: '010-0000-0001',
  interest: 'internet_tv',
  contactTime: '평일 저녁',
  consentCollection: true,
  marketingOptIn: false,
  privacyVersion: 'privacy-test-v1',
  noticeVersion: 'privacy-test-v1',
  noticeKeys: ['n1'],
  noticeHashes: noticeHashes(ctx.notices),
  idempotencyKey: 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab',
};

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof LeadRejected ? e.code : 'OTHER';
  }
  return 'NO_ERROR';
};

test('I1 정상 신청: DB로 가는 값에 이름·전화번호 평문이 없다', () => {
  const a = buildCreateLeadArgs(valid, ctx);
  const all = JSON.stringify(a);
  assert.ok(!all.includes('테스트고객'));
  assert.ok(!all.includes('01000000001') && !all.includes('010-0000-0001'));
  assert.ok(!all.includes('203.0.113.10'));
  assert.equal(a.nameMasked, '테***객');
  assert.equal(a.phoneLast4, '0001');
  assert.match(a.phoneHmac, /^[0-9a-f]{64}$/);
});

test('I2 서명은 DB로 보내는 모든 필드를 덮는다', () => {
  const { token, ...rest } = buildCreateLeadArgs(valid, ctx);
  assert.equal(token, signToken('lead', leadSignedFields(rest), ctx.signingKey, ctx.nowSeconds));
  assert.notEqual(token, signToken('lead', leadSignedFields({ ...rest, interest: 'other' }), ctx.signingKey, ctx.nowSeconds));
});

test('I3 동의하지 않으면 거부(서버 검증)', () => {
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, consentCollection: false }, ctx)), 'CONSENT_REQUIRED');
  const noConsent: Partial<typeof valid> = { ...valid };
  delete noConsent.consentCollection;
  assert.equal(code(() => buildCreateLeadArgs(noConsent, ctx)), 'CONSENT_REQUIRED');
});

test('I4 화면의 처리방침 버전이 서버 설정과 다르면 거부', () => {
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, privacyVersion: 'privacy-old' }, ctx)), 'CONSENT_VERSION_MISMATCH');
});

test('I5 브라우저가 암호문·HMAC·리드 ID를 직접 넣으면 거부(허용 필드 외 금지)', () => {
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, phoneHmac: 'f'.repeat(64) }, ctx)), 'INVALID_INPUT');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, nameEnc: 'v1:x' }, ctx)), 'INVALID_INPUT');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, leadId: '30000000-0000-4000-8000-000000000001' }, ctx)), 'INVALID_INPUT');
});

test('I6 형식 오류 거부', () => {
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, phone: '02-123-4567' }, ctx)), 'INVALID_PHONE');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, name: '<script>' }, ctx)), 'INVALID_INPUT');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, interest: 'mobile' }, ctx)), 'INVALID_INPUT');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, idempotencyKey: 'short' }, ctx)), 'INVALID_INPUT');
});

test('I7 수집 차단 스위치: 기본·운영·검수·원격 DB에서는 꺼짐', () => {
  const local = 'postgres://app_server@127.0.0.1:54329/fideon_test';
  assert.equal(leadIntakeGate({}).enabled, false);
  assert.equal(leadIntakeGate({ LEAD_INTAKE_MODE: 'live', DATABASE_URL: local }).enabled, false);
  assert.equal(leadIntakeGate({ LEAD_INTAKE_MODE: 'local', DATABASE_URL: local, VERCEL_ENV: 'production' }).enabled, false);
  assert.equal(leadIntakeGate({ LEAD_INTAKE_MODE: 'local', DATABASE_URL: local, VERCEL_ENV: 'preview' }).enabled, false);
  assert.equal(
    leadIntakeGate({ LEAD_INTAKE_MODE: 'local', DATABASE_URL: 'postgres://u@db.example.supabase.co:6543/postgres' }).enabled,
    false,
  );
  assert.equal(leadIntakeGate({ LEAD_INTAKE_MODE: 'local', DATABASE_URL: local }).enabled, true);
});

test('IN1 필수 고지 미확정(실제 설정 기본값)이면 접수 거부', () => {
  const { notices: _omit, ...real } = ctx;
  assert.equal(code(() => buildCreateLeadArgs(valid, real)), 'NOTICE_NOT_CONFIRMED');
  assert.equal(code(() => buildCreateLeadArgs(valid, { ...ctx, notices: { ...ctx.notices, confirmed: false } })), 'NOTICE_NOT_CONFIRMED');
});

test('IN2 고지 버전 불일치·항목 확인 누락·중복·추가 키는 거부', () => {
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, noticeVersion: 'old' }, ctx)), 'NOTICE_VERSION_MISMATCH');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, noticeKeys: [] }, ctx)), 'NOTICE_ACK_REQUIRED');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, noticeKeys: ['n1', 'n1'] }, ctx)), 'NOTICE_ACK_REQUIRED');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, noticeKeys: ['n1', 'x'] }, ctx)), 'NOTICE_ACK_REQUIRED');
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, noticeVersion: undefined }, ctx)), 'INVALID_INPUT');
});

test('IN3 처리방침 버전과 고지 버전이 다르면(설정 오류) 거부', () => {
  assert.equal(code(() => buildCreateLeadArgs(valid, { ...ctx, notices: { ...ctx.notices, version: 'other' } })), 'NOTICE_NOT_CONFIRMED');
});

test('I-FU 대표 직접 연락 동의: 체크(true)일 때만 서명된 후속 연락 인자 생성, false·문자열은 거부, 서명은 키·연락처 해시·처리방침 버전을 덮는다', () => {
  assert.equal(buildCreateLeadArgs(valid, ctx).followup, undefined);
  const a = buildCreateLeadArgs({ ...valid, callbackConsent: true }, ctx);
  assert.ok(a.followup);
  assert.equal(a.followup.phoneHmac, a.phoneHmac);
  assert.equal(a.followup.idempotencyKey, valid.idempotencyKey);
  assert.equal(a.followup.privacyVersion, 'privacy-test-v1');
  assert.equal(a.followup.token, signToken('lead', ['followup', valid.idempotencyKey, a.phoneHmac, 'privacy-test-v1'], ctx.signingKey, ctx.nowSeconds));
  assert.ok(!JSON.stringify(a.followup).includes('010'));
  for (const v of [false, 'true', 1]) assert.equal(code(() => buildCreateLeadArgs({ ...valid, callbackConsent: v }, ctx)), 'INVALID_INPUT');
});

test('I-LIVE 운영 접수 Gate(PM 11/22): 기본 꺼짐, 모든 조건 충족 시에만 열림, 조건 하나만 빠져도 사유 코드로 닫힘, 실제 고지(미확정)면 항상 닫힘', () => {
  const b64 = (n: number) => Buffer.alloc(32, n).toString('base64');
  const LIVE = {
    LEAD_INTAKE_MODE: 'live', VERCEL_ENV: 'production', PRIVACY_POLICY_VERSION: 'privacy-test-v1',
    DATABASE_URL: 'postgresql://app_server@db.example-prod.test:5432/postgres', LEAD_INTAKE_DB_HOST: 'db.example-prod.test',
    FIDEON_LEAD_SIGNING_KEY: `1:${b64(0x22)}`, PII_ENC_KEYS: JSON.stringify({ 1: b64(1) }), PII_ENC_CURRENT: '1', PII_HMAC_KEY: b64(3), PII_IP_HASH_KEY: b64(4),
    TURNSTILE_SECRET_KEY: 'test-secret', PUBLIC_HOSTNAME: 'example-prod.test',
  };
  const g = (over: Record<string, string | undefined>, n = ctx.notices) => leadIntakeGate({ ...LIVE, ...over }, n);
  assert.deepEqual(g({}), { enabled: true, reason: 'LIVE' });
  assert.deepEqual(leadIntakeGate({ ...LIVE }), { enabled: false, reason: 'NOTICE_NOT_CONFIRMED' }, '실제 고지 상수(미확정)는 항상 닫힘');
  const cases: [Record<string, string | undefined>, string][] = [
    [{ VERCEL_ENV: 'preview' }, 'LIVE_REQUIRES_PRODUCTION'], [{ VERCEL_ENV: undefined }, 'LIVE_REQUIRES_PRODUCTION'],
    [{ PRIVACY_POLICY_VERSION: '' }, 'NOTICE_VERSION_MISMATCH'], [{ PRIVACY_POLICY_VERSION: 'other' }, 'NOTICE_VERSION_MISMATCH'],
    [{ DATABASE_URL: 'not a url' }, 'DATABASE_URL_INVALID'], [{ DATABASE_URL: 'mysql://u@db.example-prod.test/x' }, 'DATABASE_URL_INVALID'],
    [{ DATABASE_URL: 'postgresql://u@127.0.0.1:5432/x', LEAD_INTAKE_DB_HOST: '127.0.0.1' }, 'LIVE_DB_LOCAL'],
    [{ LEAD_INTAKE_DB_HOST: '' }, 'LIVE_DB_HOST_MISMATCH'], [{ LEAD_INTAKE_DB_HOST: 'other.example-prod.test' }, 'LIVE_DB_HOST_MISMATCH'],
    [{ FIDEON_LEAD_SIGNING_KEY: undefined }, 'LIVE_KEYS_INVALID'], [{ FIDEON_LEAD_SIGNING_KEY: `1:${Buffer.alloc(8).toString('base64')}` }, 'LIVE_KEYS_INVALID'],
    [{ PII_ENC_KEYS: '{bad' }, 'LIVE_KEYS_INVALID'], [{ PII_ENC_CURRENT: '2' }, 'LIVE_KEYS_INVALID'], [{ PII_HMAC_KEY: '' }, 'LIVE_KEYS_INVALID'],
    [{ TURNSTILE_SECRET_KEY: '' }, 'LIVE_BOT_CHECK_NOT_CONFIGURED'], [{ PUBLIC_HOSTNAME: undefined }, 'LIVE_BOT_CHECK_NOT_CONFIGURED'],
    [{ LEAD_INTAKE_MODE: 'LIVE' }, 'LEAD_INTAKE_DISABLED'], [{ LEAD_INTAKE_MODE: undefined }, 'LEAD_INTAKE_DISABLED'],
  ];
  for (const [over, reason] of cases) assert.deepEqual(g(over), { enabled: false, reason }, JSON.stringify(over));
  assert.equal(g({}, { ...ctx.notices, confirmed: false }).enabled, false);
  assert.equal(leadIntakeGate({ LEAD_INTAKE_MODE: 'local', DATABASE_URL: 'postgres://app_server@127.0.0.1:54329/fideon_test' }).enabled, true, 'local 기존 동작 유지');
});
