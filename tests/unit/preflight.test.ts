// 출시 설정 사전 점검: 값 비노출, 형식 판정, 정책 위반 표시, 확인 불가 항목 구분
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { destinationStatus, renderChecks, runChecks, type Check } from '../../scripts/preflight/checks';

const layoutSource = readFileSync('src/app/layout.tsx', 'utf8');
const SECRET = {
  PUBLIC_SITE_ORIGIN: 'https://www.fideon-secret-domain.kr',
  LAUNCH_INTAKE_DESTINATION: 'https://partner-intake-secret.kr/apply/dealer-7781',
  ADMIN_AUTH_MODE: 'supabase',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdsecretref.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SECRETVALUE123',
  FIDEON_STAFF_SIGNING_KEY: '1:' + Buffer.alloc(32, 7).toString('base64'),
  DATABASE_URL: 'postgresql://app_server.ref:Sup3rS3cretPw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres',
  SUPABASE_DB_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIBsecretcertbody==\n-----END CERTIFICATE-----',
};
const byId = (cs: Check[], id: string) => cs.find((c) => c.id === id)!;

test('F1 출력에 값·URL·키·비밀번호·인증서 내용이 없다', () => {
  const out = renderChecks(runChecks(SECRET, { layoutSource }));
  for (const v of ['fideon-secret-domain', 'partner-intake-secret', 'dealer-7781', 'abcdsecretref', 'SECRETVALUE', Buffer.alloc(32, 7).toString('base64'),
    'Sup3rS3cretPw', 'app_server.ref', 'pooler.supabase.com', 'secretcertbody']) assert.ok(!out.includes(v), v);
});

test('F2 완비 환경: 형식 OK, 그래도 Auth 대시보드·풀러·CA 실검증·광고 계정·개인정보는 확인 불가로 남음', () => {
  const cs = runChecks(SECRET, { layoutSource });
  for (const id of ['P1', 'A3', 'A4', 'D1', 'D2', 'P4']) assert.equal(byId(cs, id).status, 'OK', id);
  for (const id of ['A5', 'D3', 'P5', 'P9']) assert.equal(byId(cs, id).status, 'UNVERIFIABLE', id);
  assert.equal(byId(cs, 'P3').status, 'INFO');
  assert.match(byId(cs, 'P3').note, /미확인/);
  assert.match(renderChecks(cs), /검증하지 않았다/);
});

test('F3 빈 환경: 누락 표시 + 보호된 설정 위치·권한 안내, 스위치는 꺼짐', () => {
  const cs = runChecks({}, { layoutSource });
  assert.equal(byId(cs, 'P1').status, 'MISSING');
  assert.equal(byId(cs, 'P3').status, 'MISSING');
  assert.match(byId(cs, 'P3').note, /광고 예약·게시·집행 대기/);
  assert.equal(byId(cs, 'D1').status, 'MISSING');
  for (const id of ['P6', 'P7', 'P8', 'A1', 'P2']) assert.equal(byId(cs, id).status, 'OFF', id);
  const out = renderChecks(cs);
  assert.match(out, /설정 위치: Vercel 프로젝트 → Settings → Environment Variables/);
  assert.match(out, /필요 권한/);
});

test('F4 정책 위반: 승인 없이 접수 양식·서버 접수가 열리면 POLICY', () => {
  const cs = runChecks({ NEXT_PUBLIC_LEAD_FORM_ENABLED: 'true', LEAD_INTAKE_MODE: 'local', DATABASE_URL: 'postgres://app_server@127.0.0.1:54329/x' }, { layoutSource });
  assert.equal(byId(cs, 'P7').status, 'POLICY');
  assert.equal(byId(cs, 'P6').status, 'POLICY');
  assert.equal(byId(cs, 'D1').status, 'INFO'); // 로컬 가상 DB
  assert.equal(byId(runChecks({}, { layoutSource: 'robots: { index: true }' }), 'P2').status, 'POLICY');
});

test('F5 형식 오류: 원격 DB에 CA 없음·PEM 아님, 서명 키 형식, Supabase URL, DB URL', () => {
  assert.equal(byId(runChecks({ DATABASE_URL: SECRET.DATABASE_URL }, { layoutSource }), 'D2').status, 'MISSING');
  assert.equal(byId(runChecks({ DATABASE_URL: SECRET.DATABASE_URL, SUPABASE_DB_CA_CERT: 'not a cert' }, { layoutSource }), 'D2').status, 'INVALID');
  assert.equal(byId(runChecks({ FIDEON_STAFF_SIGNING_KEY: 'short' }, { layoutSource }), 'A3').status, 'INVALID');
  assert.equal(byId(runChecks({ NEXT_PUBLIC_SUPABASE_URL: 'http://x.supabase.co' }, { layoutSource }), 'A4').status, 'INVALID');
  assert.equal(byId(runChecks({ DATABASE_URL: 'mysql://x' }, { layoutSource }), 'D1').status, 'INVALID');
});

test('F6 목적지: https 공개 도메인·쿼리 없음만, FIDEON 비활성 경로 거부', () => {
  for (const bad of ['http://partner.kr/a', 'https://partner.kr/a?name=kim', 'https://partner.kr/a#x', 'https://10.0.0.1/a', 'https://intake.local', 'https://u:p@partner.kr', 'nope'])
    assert.equal(destinationStatus({ LAUNCH_INTAKE_DESTINATION: bad }).status, 'INVALID', bad);
  assert.equal(destinationStatus({ PUBLIC_SITE_ORIGIN: 'https://fideon-real.kr', LAUNCH_INTAKE_DESTINATION: 'https://fideon-real.kr/consult' }).status, 'POLICY');
  assert.equal(destinationStatus({ PUBLIC_SITE_ORIGIN: 'https://fideon-real.kr', LAUNCH_INTAKE_DESTINATION: 'https://fideon-real.kr/api/admin/leads' }).status, 'POLICY');
  assert.equal(destinationStatus({ LAUNCH_INTAKE_DESTINATION: 'https://partner.kr/apply' }).status, 'INFO');
});

test('F9 Turnstile·보안 점검: 완비 환경 OK, 누락·형식 오류·시험 값·공개 변수 비밀 이름은 표시, 값은 출력에 없음', () => {
  const FULL = { ...SECRET, TURNSTILE_SECRET_KEY: '0xSECRETTURN', NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0xSITEKEY', PUBLIC_HOSTNAME: 'www.fideon-secret-domain.kr',
    PII_ENC_KEYS: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }), PII_ENC_CURRENT: '1', PII_HMAC_KEY: Buffer.alloc(32, 3).toString('base64'), PII_IP_HASH_KEY: Buffer.alloc(32, 4).toString('base64'), CONSULT_SESSION_KEY: Buffer.alloc(32, 5).toString('base64') };
  const cs = runChecks(FULL, { layoutSource });
  for (const id of ['T1', 'T2', 'T3', 'T4', 'S1', 'S5', 'S6']) assert.equal(byId(cs, id).status, 'OK', id);
  assert.equal(byId(cs, 'T5').status, 'UNVERIFIABLE');
  assert.equal(byId(cs, 'S2').status, 'OFF');
  const out = renderChecks(cs);
  for (const v of ['0xSECRETTURN', '0xSITEKEY', Buffer.alloc(32, 1).toString('base64'), Buffer.alloc(32, 5).toString('base64')]) assert.ok(!out.includes(v), v);
  const bad = runChecks({ ...FULL, TURNSTILE_SECRET_KEY: '', PUBLIC_HOSTNAME: 'https://x.kr/a', TURNSTILE_VERIFY_URL_TEST: 'http://127.0.0.1:1/t', NEXT_PUBLIC_OPENAI_API_KEY: 'x', PII_ENC_CURRENT: '9', CONSULT_SESSION_KEY: 'c2hvcnQ=', CONSULT_AI_API_KEY: 'sk-x', AD_EXECUTION_ENABLED: 'true', CONSULT_AI_MODEL: 'openai' }, { layoutSource });
  assert.deepEqual(['T1', 'T3', 'T4', 'S1', 'S5', 'S6', 'S4'].map((id) => byId(bad, id).status), ['MISSING', 'INVALID', 'INVALID', 'INVALID', 'INVALID', 'INVALID', 'INVALID']);
  assert.deepEqual(['S2', 'S3'].map((id) => byId(bad, id).status), ['POLICY', 'POLICY']);
  const out2 = renderChecks(bad);
  for (const v of ['sk-x', 'x.kr', '127.0.0.1']) assert.ok(!out2.includes(v), v);
});

test('F10 관리자 출처 스위치: db가 설정되면 정책 표시(제거 안내), 미설정은 OFF', () => {
  const off = runChecks({}, { layoutSource });
  for (const k of ['ADMIN_LEADS_SOURCE', 'ADMIN_POLICY_SOURCE', 'ADMIN_AD_SOURCE']) assert.equal(byId(off, `R:${k}`).status, 'OFF');
  const on = runChecks({ ADMIN_POLICY_SOURCE: 'db', ADMIN_AD_SOURCE: 'mock' }, { layoutSource });
  assert.deepEqual([byId(on, 'R:ADMIN_POLICY_SOURCE').status, byId(on, 'R:ADMIN_AD_SOURCE').status], ['POLICY', 'OFF']);
});

test('F11 고지 점검: 현재 상수는 미확정이라 N1 POLICY(접수 차단 유지), 값 비노출, DB 대조는 확인 불가로 남음', () => {
  const cs = runChecks({ PRIVACY_POLICY_VERSION: 'privacy-x' }, { layoutSource });
  assert.equal(byId(cs, 'N1').status, 'POLICY');
  assert.match(byId(cs, 'N1').note, /NOTICE_NOT_CONFIRMED/);
  assert.equal(byId(cs, 'N2').status, 'POLICY');
  assert.equal(byId(runChecks({}, { layoutSource }), 'N2').status, 'MISSING');
  assert.equal(byId(cs, 'N3').status, 'UNVERIFIABLE');
});
