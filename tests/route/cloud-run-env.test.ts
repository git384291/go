// 코사장 11/27 Cloud Run 준비: 운영 판별 중앙화(src/server/env/deployEnv.ts)와 Cloud Run 모의 환경(K_SERVICE) 안전장치 시험(CR-ENV1~12).
// 외부 호출 없음. Turnstile은 기존 코드 회귀만(중복 개발 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isHostedDeploy, isLiveProduction, isPreview, isProduction, onCloudRun, onVercel } from '../../src/server/env/deployEnv';
import { consultModelFromEnv } from '../../src/server/consult/openAiChatModel';
import { freeTierEnvAllowed } from '../../src/server/consult/geminiChatModel';
import { adminAuthMode, adminMockVisible } from '../../src/server/auth/adminAuthMode';
import { dbReadReady } from '../../src/server/admin/leadsSource';
import { leadIntakeGate } from '../../src/server/leads/intake';
import { TURNSTILE_VERIFY_URL, turnstileVerifyUrl } from '../../src/server/leads/turnstile';
import { searchIndexingAllowed } from '../../src/content/seo';
import { clientIpFrom, diagIpEnabled } from '../../src/server/http/clientIp';
import { GET as healthGet, HEAD as healthHead } from '../../src/app/api/healthz/route';

const CR = { K_SERVICE: 'bareun365-web', K_REVISION: 'bareun365-web-00001', NODE_ENV: 'production' };

test('CR-ENV1 판별표: 운영 표식 3종 각각 운영, 표식 없으면 운영 아님', () => {
  for (const e of [{ APP_ENV: 'production' }, { VERCEL_ENV: 'production' }, { K_SERVICE: 'x' }]) assert.equal(isProduction(e), true, JSON.stringify(e));
  for (const e of [{}, { NODE_ENV: 'production' }, { APP_ENV: 'dev' }, { VERCEL_ENV: 'preview' }, { K_SERVICE: '   ' }]) assert.equal(isProduction(e), false, JSON.stringify(e));
});

test('CR-ENV2 충돌 시 운영 우선(닫힘), 여는 판정은 검수 표식이 있으면 열지 않음', () => {
  assert.equal(isProduction({ K_SERVICE: 'x', APP_ENV: 'dev' }), true);
  assert.equal(isProduction({ VERCEL_ENV: 'preview', APP_ENV: 'production' }), true);
  assert.equal(isPreview({ VERCEL_ENV: 'preview', APP_ENV: 'production' }), false);
  assert.equal(isLiveProduction({ VERCEL_ENV: 'preview', APP_ENV: 'production' }), false);
  assert.equal(isLiveProduction({ VERCEL_ENV: 'development', K_SERVICE: 'x' }), false);
  assert.equal(isLiveProduction(CR), true);
  for (const v of ['staging', 'Production', 'prod', 'preview ', 'test']) assert.equal(isLiveProduction({ APP_ENV: 'production', VERCEL_ENV: v }), false, `미지 값 ${v}`);
  assert.equal(isLiveProduction({ APP_ENV: 'production', VERCEL_ENV: '' }), true);
  assert.equal(isLiveProduction({ VERCEL_ENV: 'production' }), true);
  assert.equal(isLiveProduction({ K_SERVICE: 'x', VERCEL_ENV: 'staging' }), false);
  assert.equal(isHostedDeploy(CR), true);
  assert.equal(isHostedDeploy({ NODE_ENV: 'development' }), false);
  assert.equal(onCloudRun(CR), true);
  assert.equal(onVercel({ VERCEL: '1', K_SERVICE: 'x' }), false, 'Cloud Run 표식이 있으면 Vercel 헤더 신뢰 경계를 쓰지 않음');
});

test('CR-ENV3 Cloud Run: 모의 AI 모델 차단(APP_ENV=dev를 넣어도)', () => {
  assert.equal(consultModelFromEnv({ ...CR, CONSULT_AI_MODEL: 'mock' }, null), null);
  assert.equal(consultModelFromEnv({ ...CR, APP_ENV: 'dev', CONSULT_AI_MODEL: 'mock' }, null), null);
  assert.notEqual(consultModelFromEnv({ NODE_ENV: 'test', CONSULT_AI_MODEL: 'mock' }, null), null, '대조: 로컬 시험은 그대로');
});

test('CR-ENV4 Cloud Run: Gemini 무료 등급 차단(APP_ENV=dev 충돌 포함)', () => {
  assert.equal(freeTierEnvAllowed(CR), false);
  assert.equal(freeTierEnvAllowed({ ...CR, APP_ENV: 'dev', NODE_ENV: 'development' }), false);
  assert.equal(freeTierEnvAllowed({ NODE_ENV: 'test' }), true, '대조');
});

test('CR-ENV5 Cloud Run: 관리자 인증 자동 차단·가상 관리자 화면 숨김', () => {
  const full = { ADMIN_AUTH_MODE: 'supabase', NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'x', FIDEON_STAFF_SIGNING_KEY: 'x', DATABASE_URL: 'x', SUPABASE_DB_CA_CERT: 'x' };
  assert.equal(adminAuthMode({ ...full, ...CR }), 'disabled');
  assert.equal(adminAuthMode(full), 'supabase', '대조');
  assert.equal(adminMockVisible({ NODE_ENV: 'development', K_SERVICE: 'x' }), false);
  assert.equal(adminMockVisible({ NODE_ENV: 'development' }), true, '대조');
});

test('CR-ENV6 Cloud Run: 로컬 가상 DB 읽기·로컬 접수 차단', () => {
  const ok = { ADMIN_LEADS_SOURCE: 'db', DATABASE_URL: 'postgres://app_server@127.0.0.1:54329/fideon_lrs_1234_0a1b2c3d', NODE_ENV: 'test' };
  assert.equal(dbReadReady(ok), true, '대조');
  assert.equal(dbReadReady({ ...ok, K_SERVICE: 'x' }), false);
  assert.equal(dbReadReady({ ...ok, APP_ENV: 'production' }), false);
  const local = { LEAD_INTAKE_MODE: 'local', DATABASE_URL: 'postgres://u@127.0.0.1:5432/x' };
  assert.equal(leadIntakeGate(local).enabled, true, '대조');
  assert.deepEqual(leadIntakeGate({ ...local, K_SERVICE: 'x' }), { enabled: false, reason: 'LOCAL_MODE_NOT_ALLOWED_ON_VERCEL' });
});

test('CR-ENV7 실접수(live): 검수 표식이 섞이면 운영 게이트에서 닫힘, Cloud Run은 운영 게이트 통과 후 다음 조건으로 판정', () => {
  assert.equal(leadIntakeGate({ LEAD_INTAKE_MODE: 'live', VERCEL_ENV: 'preview', APP_ENV: 'production' }).reason, 'LIVE_REQUIRES_PRODUCTION');
  assert.equal(leadIntakeGate({ LEAD_INTAKE_MODE: 'live' }).reason, 'LIVE_REQUIRES_PRODUCTION');
  const r = leadIntakeGate({ LEAD_INTAKE_MODE: 'live', ...CR });
  assert.equal(r.enabled, false, '필수 고지 미확정 등 다른 조건으로 여전히 닫힘');
  assert.notEqual(r.reason, 'LIVE_REQUIRES_PRODUCTION');
});

test('CR-ENV8 검색 노출: Cloud Run 운영 + 명시 허용 + 공식 주소일 때만, 검수 표식 섞이면 거부', () => {
  const open = { SEARCH_INDEXING: 'allow', PUBLIC_SITE_ORIGIN: 'https://bareun365.com' };
  assert.equal(searchIndexingAllowed({ ...CR, ...open }), true);
  assert.equal(searchIndexingAllowed({ ...open, VERCEL_ENV: 'preview', APP_ENV: 'production' }), false);
  assert.equal(searchIndexingAllowed({ ...CR, PUBLIC_SITE_ORIGIN: 'https://bareun365.com' }), false);
});

test('CR-ENV9 Turnstile 회귀: Cloud Run에서는 시험용 확인 주소를 무시(NODE_ENV=test여도)', () => {
  const o = 'http://127.0.0.1:9999/verify';
  assert.equal(turnstileVerifyUrl({ NODE_ENV: 'test', TURNSTILE_VERIFY_URL_TEST: o }), o, '대조: 로컬 시험');
  assert.equal(turnstileVerifyUrl({ NODE_ENV: 'test', K_SERVICE: 'x', TURNSTILE_VERIFY_URL_TEST: o }), TURNSTILE_VERIFY_URL);
  assert.equal(turnstileVerifyUrl({ NODE_ENV: 'test', APP_ENV: 'production', TURNSTILE_VERIFY_URL_TEST: o }), TURNSTILE_VERIFY_URL);
});

test('CR-ENV10 고객 IP: Cloud Run 등 Vercel 밖 호스팅은 위조 가능한 헤더를 믿지 않고 공용 버킷(미완료 표시), Vercel·로컬은 기존 그대로', () => {
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  const spoof = h({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.9.9.9' });
  assert.equal(clientIpFrom(spoof, { onVercel: false, hosted: true }), '0.0.0.0');
  assert.equal(clientIpFrom(spoof, { onVercel: true }), '1.2.3.4');
  assert.equal(clientIpFrom(spoof, { onVercel: false }), '1.2.3.4');
  assert.equal(diagIpEnabled({ VERCEL: '1', VERCEL_ENV: 'preview', DIAG_IP_ENABLED: '1' }), true, '대조');
  assert.equal(diagIpEnabled({ VERCEL: '1', VERCEL_ENV: 'preview', DIAG_IP_ENABLED: '1', K_SERVICE: 'x' }), false);
  assert.equal(diagIpEnabled({ VERCEL: '1', VERCEL_ENV: 'preview', DIAG_IP_ENABLED: '1', APP_ENV: 'production' }), false);
});

test('CR-ENV11 상태 확인 경로: 200·{"ok":true}·캐시 금지, 환경 값 노출 없음', async () => {
  const r = healthGet();
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"ok":true}');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(healthHead().status, 200);
  const src = readFileSync('src/app/api/healthz/route.ts', 'utf8');
  assert.equal(/process\.env|import /.test(src), false, '환경 값·DB·외부 모듈을 읽지 않음');
});

test('CR-ENV12 Dockerfile·.dockerignore: 비루트·8080·0.0.0.0·standalone, 이미지에 비밀·.env 없음', () => {
  const d = readFileSync('Dockerfile', 'utf8');
  assert.match(d, /^USER app$/m);
  assert.match(d, /PORT=8080/);
  assert.match(d, /HOSTNAME=0\.0\.0\.0/);
  assert.match(d, /NEXT_OUTPUT=standalone/);
  assert.match(d, /CMD \["node", "server\.js"\]/);
  // 빌드 ARG는 공개 값 허용 목록만(사이트 키·Supabase 공개 키는 공개 값 예외). 비밀 이름은 ARG·ENV 어디에도 없음
  const PUBLIC_ARGS = ['NEXT_PUBLIC_LEAD_FORM_ENABLED', 'NEXT_PUBLIC_PRIVACY_POLICY_VERSION', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_KAKAO_CHANNEL_URL'];
  const args = [...d.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]);
  assert.deepEqual([...args].sort(), [...PUBLIC_ARGS].sort());
  assert.equal(/(SECRET|TOKEN|PASSWORD|DATABASE_URL|SIGNING|PII_|HMAC|SERVICE_ROLE)/.test(d.replace(/^#.*$/gm, '')), false);
  const keyNames = [...d.replace(/^#.*$/gm, '').matchAll(/[A-Z0-9_]*KEY[A-Z0-9_]*/g)].map((m) => m[0]);
  assert.ok(keyNames.every((k) => k === 'NEXT_PUBLIC_TURNSTILE_SITE_KEY' || k === 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), keyNames.join(','));
  const lastUser = [...d.matchAll(/^USER (\S+)/gm)].map((m) => m[1]).at(-1);
  assert.equal(lastUser, 'app');
  const ig = readFileSync('.dockerignore', 'utf8').split('\n').map((s) => s.trim());
  for (const x of ['.env', '.env.*', '.git', 'node_modules', '*.pem', '*.key']) assert.ok(ig.includes(x), x);
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /NEXT_OUTPUT === 'standalone'/, 'standalone은 이미지 빌드에서만');
});
