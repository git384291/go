-- 가상 필수 고지 문구(테스트 DB 전용). 실제 고지 문구가 아니다.
\set ON_ERROR_STOP 1
insert into core.notice_texts (version, notice_key, body) values
  ('privacy-test-v1', 'collection_purpose', '수집 목적: 상담 연락(가상 고지)'),
  ('privacy-test-v1', 'not_a_contract',     '상담 신청은 가입 확정이 아닙니다(가상 고지)'),
  ('privacy-test-v1', 'policy_confirm',     '요금·사은품은 상담 시 확인한 정책 기준입니다(가상 고지)');
