// PM 11/21: 실제 AI·광고 API 연동 준비 상태 점검. 키·스위치를 전부 켜 봐도 실제 호출 어댑터가 없어 열리지 않음을 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createModel } from '../../src/server/consult/chatModel';
import { createPlatform } from '../../src/server/advertising/platform';
import { TURNSTILE_VERIFY_URL, turnstileVerifyUrl } from '../../src/server/leads/turnstile';

const ALL_ON = { CONSULT_AI_MODEL: 'openai', CONSULT_AI_API_KEY: 'sk-test', CONSULT_AI_MONTHLY_BUDGET_KRW: '100000', AD_PLATFORM: 'google', AD_EXECUTION_ENABLED: 'true', AD_API_KEY: 'k', NODE_ENV: 'production' };

test('RD1 연동 준비 점검: 키·실행 스위치를 모두 켜도 실제 AI·광고 어댑터가 없어 모델·플랫폼은 null(닫힘)', () => {
  assert.equal(createModel(ALL_ON), null);
  assert.equal(createPlatform(ALL_ON), null);
  for (const v of ['openai', 'anthropic', 'gpt-4o', 'MOCK', '', undefined]) assert.equal(createModel({ CONSULT_AI_MODEL: v }), v === undefined ? null : null);
  assert.equal(createModel({ CONSULT_AI_MODEL: 'mock' })?.costPerCallKrw, 0);
  assert.equal(createPlatform({ AD_PLATFORM: 'mock' })?.live, false);
});
test('RD2 정적: 실제 AI·광고 서비스 주소·SDK·fetch 호출 코드가 src 어디에도 없음(봇 확인 1곳 제외)', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  const hosts = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|googleads\.googleapis|searchad\.naver|adsapi|graph\.facebook|business-api\.tiktok|ads-api\.|from ['"](openai|@anthropic-ai\/sdk|google-ads-api|@google\/generative-ai)['"]/;
  for (const f of walk('src').filter((p) => /\.(ts|tsx)$/.test(p))) {
    const s = readFileSync(f, 'utf8');
    // 광고 문구 생성기(주입형 전송, 호출 코드 미연결)만 예외. 아래에서 어디서도 불러 쓰지 않음을 확인한다
    if (!f.endsWith('advertising/openAiAdGenerator.ts') && !f.endsWith('advertising/googleAdsPlatform.ts')) assert.ok(!hosts.test(s), `${f}: 실제 AI·광고 서비스 연동 코드`);
    if (!f.includes(`${path.sep}advertising${path.sep}`)) assert.ok(!/openAiAdGenerator|googleAdsPlatform/.test(s), `${f}: 광고 문구 생성기를 앱 경로에서 사용`);
    if (!f.endsWith('advertising/openAiAdGenerator.ts') && /\bfetch\(/.test(s) && !/^['"]use client['"]/.test(s.trimStart())) assert.ok(/leads\/turnstile\.ts$|supabase/i.test(f), `${f}: 서버 외부 호출은 봇 확인뿐`);
  }
});
test('RD3 봇 확인 주소: 기본은 Cloudflare 고정값, 시험 주소는 로컬 시험 환경의 loopback http만, 운영·미리보기·외부 주소는 무시', () => {
  assert.equal(turnstileVerifyUrl({}), TURNSTILE_VERIFY_URL);
  const T = 'http://127.0.0.1:3138/turnstile';
  assert.equal(turnstileVerifyUrl({ NODE_ENV: 'development', TURNSTILE_VERIFY_URL_TEST: T }), T);
  assert.equal(turnstileVerifyUrl({ NODE_ENV: 'test', TURNSTILE_VERIFY_URL_TEST: T }), T);
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development', VERCEL: '1' }, { NODE_ENV: 'development', VERCEL_ENV: 'preview' }, {}]) assert.equal(turnstileVerifyUrl({ ...env, TURNSTILE_VERIFY_URL_TEST: T }), TURNSTILE_VERIFY_URL);
  for (const bad of ['https://evil.test/x', 'http://evil.test:80/x', 'http://127.0.0.1.evil.test:3138/x', 'http://127.0.0.1:3138@evil.test/x', 'http://localhost:3138/a?b=c', 'ftp://127.0.0.1:3138/x']) assert.equal(turnstileVerifyUrl({ NODE_ENV: 'development', TURNSTILE_VERIFY_URL_TEST: bad }), TURNSTILE_VERIFY_URL, bad);
});
