import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIpFrom, diagIpEnabled } from '../../src/server/http/clientIp';

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
const vercel = { onVercel: true };
const local = { onVercel: false };

test('T20 Vercel: x-real-ip(Vercel이 설정)만 사용', () => {
  assert.equal(clientIpFrom(headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }), vercel), '203.0.113.7');
});

test('T21 Vercel: x-real-ip가 없으면 x-forwarded-for로 대체하지 않고 공용 버킷', () => {
  assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '1.2.3.4' }), vercel), '0.0.0.0');
});

test('T22 로컬: 요청자가 x-forwarded-for 앞부분에 넣은 가짜 IP는 쓰지 않는다', () => {
  assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }), local), '203.0.113.9');
});

test('T23 형식이 아니면 공용 버킷(0.0.0.0)으로 안전하게 실패', () => {
  assert.equal(clientIpFrom(headers({ 'x-real-ip': 'evil', 'x-forwarded-for': "1.2.3.4, ' or 1=1" }), local), '0.0.0.0');
  assert.equal(clientIpFrom(headers({}), local), '0.0.0.0');
  assert.equal(clientIpFrom(headers({ 'x-real-ip': '999.1.1.1' }), vercel), '0.0.0.0');
});

test('T24 IPv6 허용', () => {
  assert.equal(clientIpFrom(headers({ 'x-real-ip': '2001:db8::1' }), vercel), '2001:db8::1');
});

test('T25 IP 진단 경로는 Vercel 검수 배포에서 명시적으로 켰을 때만 열린다', () => {
  assert.equal(diagIpEnabled({ VERCEL: '1', VERCEL_ENV: 'preview', DIAG_IP_ENABLED: '1' }), true);
  assert.equal(diagIpEnabled({ VERCEL: '1', VERCEL_ENV: 'production', DIAG_IP_ENABLED: '1' }), false);
  assert.equal(diagIpEnabled({ VERCEL: '1', VERCEL_ENV: 'preview' }), false);
  assert.equal(diagIpEnabled({ DIAG_IP_ENABLED: '1' }), false);
});
