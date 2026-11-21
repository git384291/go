// 시험용: "고지 확정 이후" 전체 접수 흐름을 폐기 DB에서 한 번 실행한다. 실제 상수(미확정)는 건드리지 않고, 시험 설정만 쓴다.
// 순서: DB에서 해당 버전의 최신 검수 승인 확인(없으면 접수하지 않고 종료 코드 3) → 화면 설정을 DB 승인 문구로 구성·대조 → 실제 접수 코드(submitLead) 실행.
import postgres from 'postgres';
import { withRoleOn } from '../../src/server/db/client';
import { submitLead } from '../../src/server/leads/submitLead';
import { compareNoticeTexts, noticeReadiness, type NoticeConfig } from '../../src/content/requiredNotices';
import { createPiiCrypto, piiKeysFromEnv } from '../../src/server/security/piiCrypto';
import { signingKeyFromEnv } from '../../src/server/security/token';

const VERSION = 'next-e2e-v1';
const admin = postgres(process.env.E2E_ADMIN_URL as string, { max: 1, onnotice: () => {} });
const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 1, onnotice: () => {} });
try {
  const rows = (await admin`select version, notice_key, body from core.notice_texts where version = ${VERSION} order by notice_key`) as unknown as { version: string; notice_key: string; body: string }[];
  const approved = await admin`select 1 from core.notice_reviews r where r.version = ${VERSION} and r.decision = 'approved'
    and r.texts_sha256 = (select encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex') from core.notice_texts n where n.version = ${VERSION}) limit 1`;
  if (approved.length === 0) { console.log(JSON.stringify({ ok: false, code: 'REVIEW_NOT_APPROVED' })); process.exitCode = 3; }
  else {
    const cfg: NoticeConfig = { version: VERSION, confirmed: true, items: rows.map((r) => ({ key: r.notice_key, title: '시험 고지', body: r.body })) };
    const diff = compareNoticeTexts(cfg, rows);
    const ready = noticeReadiness(cfg, VERSION);
    if (diff.length > 0 || !ready.ready) { console.log(JSON.stringify({ ok: false, code: 'CONFIG_MISMATCH', diff })); process.exitCode = 4; }
    else {
      const r = await submitLead(
        { name: '김플로우', phone: '010-8888-4321', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false, privacyVersion: VERSION, noticeVersion: VERSION, noticeKeys: cfg.items.map((n) => n.key), idempotencyKey: 'next-e2e-flow-0000000001', utmSource: 'naver', utmMedium: 'cpc', utmCampaign: 'next-e2e-camp' },
        { crypto: createPiiCrypto(piiKeysFromEnv()), signingKey: signingKeyFromEnv('lead'), currentPrivacyVersion: VERSION, clientIp: '203.0.113.88', notices: cfg },
        (fn) => withRoleOn(sql, 'public', (tx) => Promise.resolve(fn(tx as never))),
      );
      console.log(JSON.stringify(r));
      process.exitCode = r.ok ? 0 : 1;
    }
  }
} finally { await sql.end(); await admin.end(); }
