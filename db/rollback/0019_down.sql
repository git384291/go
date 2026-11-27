-- 0019 롤백: 변경 요청 함수 2개 삭제, 변경 요청 기록은 보관 테이블로 옮긴 뒤 원본 삭제. 감사 로그는 그대로 남는다.
-- 복구: 0019 재적용 후 db/rollback/0019_restore.sql, zz_grants.sql 실행. 롤백하면 접수 코드(submitLead·dealerPacket)도 이전 커밋으로 함께 되돌려야 한다.
begin;
create table pii.lead_amendments_rollback_archive as table pii.lead_amendments;
do $$
begin
  alter table pii.lead_amendments_rollback_archive enable row level security;
  alter table pii.lead_amendments_rollback_archive force row level security;
  create policy fideon_api_all on pii.lead_amendments_rollback_archive to fideon_api using (true) with check (true);
  revoke all on pii.lead_amendments_rollback_archive from public;
end $$;
drop function if exists api.application_amendments(uuid, uuid, text, uuid);
drop function if exists api.application_amend(text, text, text, text, text, text);
drop table pii.lead_amendments;
drop function if exists pii.lead_amendments_guard();
commit;
