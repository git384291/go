-- 0022 롤백: 중복 실행 방지 함수 제거(시작 기록 테이블은 보관용으로 남긴다)
drop function if exists api.ad_monitor_begin(uuid);
