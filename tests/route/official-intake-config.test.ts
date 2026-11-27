// 총판 공식 접수 경로 — 실제 서버 설정(react-server 조건, server-only 포함)의 기본 판정 (PM 6920265190 / 6920404685).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_INTAKE_ENABLED, OFFICIAL_INTAKE_REGISTRY, officialIntakeFor } from '../../src/server/intake/officialIntakeConfig';

test('OC1 실제 설정: 검수된 네이버 폼은 인터넷TV에만 노출', () => {
  assert.equal(OFFICIAL_INTAKE_ENABLED, true);
  assert.equal(OFFICIAL_INTAKE_REGISTRY.length, 1);
  assert.ok(Object.isFrozen(OFFICIAL_INTAKE_REGISTRY));
  const tv = officialIntakeFor('internet-tv');
  assert.equal(tv.state, 'on');
  if (tv.state === 'on') {
    assert.deepEqual(tv.links, [{ id: 'naver-form', label: '바른365', href: 'https://form.naver.com/response/By757YMGRuN', host: 'form.naver.com' }]);
  }
  assert.deepEqual(officialIntakeFor('internet-phone'), { state: 'off', reason: 'NO_MATCH' });
  assert.deepEqual(officialIntakeFor('cctv-security'), { state: 'off', reason: 'NO_MATCH' });
});

test('OC2 환경변수로 목적지나 상품 범위를 바꿀 수 없다', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { OFFICIAL_INTAKE_ENABLED: 'true', NEXT_PUBLIC_OFFICIAL_INTAKE_URL: 'https://intake-a.example.com/apply' });
    const tv = officialIntakeFor('internet-tv');
    assert.equal(tv.state, 'on');
    if (tv.state === 'on') assert.deepEqual(tv.links.map((l) => l.href), ['https://form.naver.com/response/By757YMGRuN']);
    assert.deepEqual(officialIntakeFor('internet-phone'), { state: 'off', reason: 'NO_MATCH' });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
