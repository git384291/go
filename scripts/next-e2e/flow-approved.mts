// 시험용: "고지 확정 이후" 접수 흐름을 폐기 DB에서 한 번 실행한다. 실제 상수(미확정)는 건드리지 않는다.
// 화면 설정은 DB 문구로 구성하고(FLOW_TAMPER=1이면 첫 항목 본문을 한 글자 바꾸고, FLOW_ONLY_KEYS=a,b면 그 항목만 둔다),
// 승인·해시·버전 검증은 접수 코드(submitLead → api.notice_intake_gate)가 서버에서 한다. 이 스크립트는 사전 검사를 하지 않는다.
import postgres from 'postgres';
import { withRoleOn } from '../../src/server/db/client';
import { submitLead } from '../../src/server/leads/submitLead';
import type { NoticeConfig } from '../../src/content/requiredNotices';
import { createPiiCrypto, piiKeysFromEnv } from '../../src/server/security/piiCrypto';
import { signingKeyFromEnv } from '../../src/server/security/token';

const VERSION = 'next-e2e-v1';
const idem = process.env.FLOW_IDEM ?? 'next-e2e-flow-0000000001';
const phone = process.env.FLOW_PHONE ?? '010-8888-4321';
const admin = postgres(process.env.E2E_ADMIN_URL as string, { max: 1, onnotice: () => {} });
const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 1, onnotice: () => {} });
try {
  const only = process.env.FLOW_ONLY_KEYS ? process.env.FLOW_ONLY_KEYS.split(',') : null;
  const rows = ((await admin`select notice_key, body from core.notice_texts where version = ${VERSION} order by notice_key`) as unknown as { notice_key: string; body: string }[])
    .filter((r) => only === null || only.includes(r.notice_key));
  const cfg: NoticeConfig = { version: VERSION, confirmed: true, items: rows.map((r, i) => ({ key: r.notice_key, title: '시험 고지', body: process.env.FLOW_TAMPER === '1' && i === 0 ? r.body + '!' : r.body })) };
  const r = await submitLead(
    { name: '김플로우', phone, interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: VERSION, noticeVersion: VERSION, noticeKeys: cfg.items.map((n) => n.key), idempotencyKey: idem, utmSource: 'naver', utmMedium: 'cpc', utmCampaign: 'next-e2e-camp',
      ...(process.env.FLOW_APP === '1' ? { application: { carrier: 'kt', productId: 'p-e2e', regionCode: 'r-e2e', installAddress: '서울시 가상구 시험로 12 101동 1203호', phoneCarrier: 'skt', email: 'e2e.test@example.com', currentCarrier: 'skb', installPref: 'asap', existingLine: 'has', ack12m: 'confirmed', ackContract3y: 'confirmed' } } : {}) },
    { crypto: createPiiCrypto(piiKeysFromEnv()), signingKey: signingKeyFromEnv('lead'), currentPrivacyVersion: VERSION, clientIp: '203.0.113.88', notices: cfg },
    (fn) => withRoleOn(sql, 'public', (tx) => Promise.resolve(fn(tx as never))),
  );
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
} finally { await sql.end(); await admin.end(); }
