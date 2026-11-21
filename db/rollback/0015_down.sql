-- 0015 롤백: 검수 함수만 삭제한다. 이미 남긴 검수 기록(core.notice_reviews, 추가 전용)과 감사 로그는 그대로 남는다.
-- 복구: 0015 재적용 후 zz_grants.sql 실행. 롤백 뒤 zz_grants.sql도 이전 버전으로 실행.
begin;
drop function if exists api.notice_review_add(uuid, uuid, text, text, jsonb, text, text);
drop function if exists api.notice_review_list(uuid, uuid, text);
commit;
