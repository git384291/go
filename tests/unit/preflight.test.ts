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
