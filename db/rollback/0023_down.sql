-- 0023 롤백: 대표 직접 연락 동의 함수 제거(기록 테이블은 보관용으로 남긴다)
drop function if exists api.followup_request(text, text, text, text);
drop function if exists api.followup_list(uuid, uuid, text);
drop function if exists api.followup_done(uuid, uuid, text, uuid);
