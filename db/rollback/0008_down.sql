-- 0008 롤백: 정책 저장소 함수·테이블을 삭제한다. 정책 데이터는 삭제 전에 core.policy_versions_rollback_archive로 옮긴다.
-- 감사 로그(core.audit_logs)는 추가 전용이라 그대로 남는다. 이미 보관 테이블이 있으면 실패한다(덮어쓰지 않음).
-- 복구: 0008을 다시 적용한 뒤 db/rollback/0008_restore.sql 실행. 롤백 뒤 zz_grants.sql도 이 변경 이전 버전으로 되돌려 실행한다.
begin;
create table core.policy_versions_rollback_archive as table core.policy_versions;
drop function if exists api.policy_published();
drop function if exists api.policy_reject(uuid, uuid, text, uuid, text);
drop function if exists api.policy_approve(uuid, uuid, text, uuid, text, jsonb);
drop function if exists api.policy_submit(uuid, uuid, text, uuid);
drop function if exists api.policy_create_draft(uuid, uuid, text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, jsonb);
drop table core.policy_versions;
drop function if exists core.policy_versions_guard();
drop function if exists core.policy_terms_shape(jsonb);
commit;
