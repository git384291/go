// 총판 공식 접수 경로 — 실제 서버 설정(react-server 조건, server-only 포함)의 기본 판정 (PM 6920265190 / 6920404685).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_INTAKE_ENABLED, OFFICIAL_INTAKE_REGISTRY, officialIntakeFor } from '../../src/server/intake/officialIntakeConfig';

test('OC1 실제 설정: 꺼짐·빈 등록부 → 모든 상품에서 링크 없음', () => {
  assert.equal(OFFICIAL_INTAKE_ENABLED, false);
  assert.equal(OFFICIAL_INTAKE_REGISTRY.length, 0);
  assert.ok(Object.isFrozen(OFFICIAL_INTAKE_REGISTRY));
  for (const slug of ['internet-tv', 'internet-phone', 'cctv-security'] as const) {
    assert.deepEqual(officialIntakeFor(slug), { state: 'off', reason: 'DISABLED' }, slug);
  }
});

test('OC2 환경변수로 켜지지 않는다', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { OFFICIAL_INTAKE_ENABLED: 'true', NEXT_PUBLIC_OFFICIAL_INTAKE_URL: 'https://intake-a.example.com/apply' });
    assert.deepEqual(officialIntakeFor('internet-tv'), { state: 'off', reason: 'DISABLED' });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
