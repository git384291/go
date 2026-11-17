// 카카오톡 상품 문의 — 실제 서버 설정(react-server 조건, server-only 포함)의 기본 판정 (PM 6938169689)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KAKAO_INQUIRY_ENABLED, KAKAO_INQUIRY_URL, KAKAO_INQUIRY_REVIEW_REF, kakaoInquiryLink } from '../../src/server/inquiry/kakaoInquiryConfig';

test('KC1 실제 설정: false·null → off(DISABLED), 환경변수로 켜지지 않음', () => {
  assert.equal(KAKAO_INQUIRY_ENABLED, false);
  assert.equal(KAKAO_INQUIRY_URL, null);
  assert.equal(KAKAO_INQUIRY_REVIEW_REF, null);
  assert.deepEqual(kakaoInquiryLink(), { state: 'off', reason: 'DISABLED' });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NEXT_PUBLIC_KAKAO_CHANNEL_URL: 'https://pf.kakao.com/_fixture0000', KAKAO_INQUIRY_ENABLED: 'true' });
    assert.deepEqual(kakaoInquiryLink(), { state: 'off', reason: 'DISABLED' });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
