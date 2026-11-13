// TypeScript 서명과 DB 검증 규칙이 같은지 확인하는 SQL을 출력한다. scripts/db-test.sh가 psql로 실행.
import { signToken } from '../src/server/security/token';
import { buildCreateLeadArgs, leadSignedFields } from '../src/server/leads/intake';
import { createPiiCrypto } from '../src/server/security/piiCrypto';

const staffKey = { keyId: 1, secret: Buffer.alloc(32, 0x11) }; // 시드의 테스트 키와 동일
const leadKey = { keyId: 1, secret: Buffer.alloc(32, 0x22) };
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const owner = '00000000-0000-4000-8000-000000000001';
const session = '10000000-0000-4000-8000-000000000001';
const staffTok = signToken('staff', [owner, session], staffKey);

const a = buildCreateLeadArgs(
  {
    name: '테스트고객',
    phone: '010-0000-0099',
    interest: 'cctv_security',
    contactTime: "주말 '오전' | 10시",
    consentCollection: true,
    marketingOptIn: true,
    privacyVersion: 'privacy-test-v1',
    idempotencyKey: 'parity-test-0000000001',
    utmSource: 'naver',
  },
  {
    crypto: createPiiCrypto({
      encKeys: { '1': Buffer.alloc(32, 1) },
      currentVersion: '1',
      hmacKey: Buffer.alloc(32, 3),
      ipHashKey: Buffer.alloc(32, 4),
    }),
    signingKey: leadKey,
    currentPrivacyVersion: 'privacy-test-v1',
    clientIp: '203.0.113.99',
  },
);
const { token, ...rest } = a;
const fields = leadSignedFields(rest);

console.log(`select test.expect_eq($$select security.verify_token('staff', ${q(staffTok)}, array[${q(owner)}, ${q(session)}])::text$$, 'true', 'S1 TS 관리자 서명 = DB 검증 통과');`);
console.log(`select test.expect_eq($$select security.verify_token('staff', ${q(staffTok)}, array[${q(owner)}, '10000000-0000-4000-8000-000000000002'])::text$$, 'false', 'S2 TS 서명 + 다른 세션 ID = 거부');`);
console.log(`select test.expect_eq($$select security.verify_token('lead', ${q(token)}, array[${fields.map(q).join(', ')}])::text$$, 'true', 'S3 TS 상담 신청 서명 = DB 검증 통과(특수문자 포함)');`);
console.log('set role app_public;');
console.log(
  `select test.expect_eq($$select api.create_lead(${q(token)}, ${q(a.nameEnc)}, ${q(a.nameMasked)}, ${q(a.phoneEnc)}, ${q(a.phoneHmac)}, ${q(a.phoneLast4)}, ${q(a.interest)}, ${q(a.contactTime)}, ${q(a.utmSource)}, ${q(a.utmMedium)}, ${q(a.utmCampaign)}, ${q(a.idempotencyKey)}, ${q(a.privacyVersion)}, ${a.consentCollection}, ${a.marketingOptIn}, ${q(a.ipHash)})$$, 'accepted', 'S4 TS가 만든 상담 신청이 실제 역할(app_public)로 저장됨');`,
);
console.log('reset role;');
console.log(`select test.expect_eq($$select count(*)::text from pii.marketing_consents m join pii.customers c on c.id = m.customer_id where c.phone_hmac = ${q(a.phoneHmac)}$$, '1', 'S5 광고 수신 동의는 별도 이력에 기록');`);
