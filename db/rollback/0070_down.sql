-- 0070 롤백: 광고성 전화 기록 api 함수 6개만 제거한다.
-- - 수신거부·시도·결과·판정 표와 추가 전용 보호 트리거는 보관용으로 남긴다(기존 데이터 삭제·덮어쓰기 없음). 수신거부 기록은 지워지지 않는다.
-- - 재적용(0070 다시 실행) 시 create table if not exists · create or replace라 남은 기록을 그대로 다시 쓴다.
-- - 순서: 앱 코드·zz_grants.sql도 함께 되돌린다(PR 되돌리기). 권한 줄이 남아 있으면 zz_grants.sql이 실패한다.
begin;
drop function if exists api.outbound_suppression_block(text, text);
drop function if exists api.outbound_suppression_check(text, text);
drop function if exists api.outbound_attempt_begin(text, text, text, text, text);
drop function if exists api.outbound_attempt_finish(bigint, text);
drop function if exists api.outbound_attempt_status(text, text);
drop function if exists api.outbound_decision_record(text, text, boolean, text, text[]);
commit;
