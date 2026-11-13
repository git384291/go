import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIpFrom } from '../../src/server/http/clientIp';

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

test('T20 고객 IP: x-real-ip를 우선 사용', () => {
  assert.equal(clientIpFrom(headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })), '203.0.113.7');
});

test('T21 고객 IP: 요청자가 x-forwarded-for 앞부분에 넣은 가짜 IP는 쓰지 않는다', () => {
  assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })), '203.0.113.9');
});

test('T22 고객 IP: 형식이 아니면 공용 버킷(0.0.0.0)으로 안전하게 실패', () => {
  assert.equal(clientIpFrom(headers({ 'x-real-ip': 'evil', 'x-forwarded-for': "1.2.3.4, ' or 1=1" })), '0.0.0.0');
  assert.equal(clientIpFrom(headers({})), '0.0.0.0');
  assert.equal(clientIpFrom(headers({ 'x-real-ip': '999.1.1.1' })), '0.0.0.0');
});

test('T23 고객 IP: IPv6 허용', () => {
  assert.equal(clientIpFrom(headers({ 'x-real-ip': '2001:db8::1' })), '2001:db8::1');
});
