-- 0016 롤백: 접수 직전 고지 게이트 함수만 삭제한다(데이터 변경 없음). 롤백하면 서버 접수 코드가 이 함수를 호출하지 못하므로 접수 코드도 이전 커밋으로 되돌려야 한다.
-- 복구: 0016 재적용 후 zz_grants.sql 실행.
begin;
drop function if exists api.notice_intake_gate(text, jsonb);
commit;
