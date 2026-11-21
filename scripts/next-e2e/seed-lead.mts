// 실제 접수 코드(submitLead: 암호화·동의·고지 기록·감사)를 폐기 DB에 한 번 실행한다. 시험용 고지 문구(가상)·시험 키만 사용.
import postgres from 'postgres';
import { withRoleOn } from '../../src/server/db/client';
import { submitLead } from '../../src/server/leads/submitLead';
import { createPiiCrypto, piiKeysFromEnv } from '../../src/server/security/piiCrypto';
import { signingKeyFromEnv } from '../../src/server/security/token';

const NOTICES = { version: 'privacy-test-v1', confirmed: true, items: ['collection_purpose', 'not_a_contract', 'policy_confirm'].map((key) => ({ key, title: '시험 고지', body: '시험용 문구' })) };
const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 1, onnotice: () => {} });
try {
  const r = await submitLead(
    { name: '김이투이', phone: '010-7777-1234', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: NOTICES.items.map((n) => n.key), idempotencyKey: 'next-e2e-seed-0000000001', utmSource: 'naver', utmMedium: 'cpc', utmCampaign: 'next-e2e-camp' },
    { crypto: createPiiCrypto(piiKeysFromEnv()), signingKey: signingKeyFromEnv('lead'), currentPrivacyVersion: 'privacy-test-v1', clientIp: '203.0.113.77', notices: NOTICES },
    (fn) => withRoleOn(sql, 'public', (tx) => Promise.resolve(fn(tx as never))),
  );
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
} finally { await sql.end(); }
