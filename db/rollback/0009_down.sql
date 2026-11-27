-- 0009 롤백: 조회 함수만 삭제한다(데이터 변경 없음). 롤백 뒤 zz_grants.sql도 이 변경 이전 버전으로 실행한다.
begin;
drop function if exists api.policy_list(uuid, uuid, text, int, int);
commit;
