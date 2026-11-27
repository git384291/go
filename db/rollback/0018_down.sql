-- 0018 롤백: launch 함수 5개 삭제, launch 기록은 보관 테이블로 옮긴 뒤 원본 삭제. 감사 로그는 그대로 남는다.
-- 복구: 0018 재적용 후 db/rollback/0018_restore.sql, zz_grants.sql 실행. 롤백하면 광고 launch 코드도 이전 커밋으로 함께 되돌려야 한다.
begin;
create table core.ad_launches_rollback_archive as table core.ad_launches;
do $$
begin
  alter table core.ad_launches_rollback_archive enable row level security;
  alter table core.ad_launches_rollback_archive force row level security;
  create policy fideon_api_all on core.ad_launches_rollback_archive to fideon_api using (true) with check (true);
  revoke all on core.ad_launches_rollback_archive from public;
end $$;
drop function if exists api.ad_launch_resolve(uuid, uuid, text, text, text, text, text);
drop function if exists api.ad_launch_paused(uuid, uuid, text, text);
drop function if exists api.ad_launch_active(uuid, uuid, text, text);
drop function if exists api.ad_launch_finish(uuid, uuid, text, text, text, text, text);
drop function if exists api.ad_launch_begin(uuid, uuid, text, text, text, int);
drop table core.ad_launches;
drop function if exists core.ad_launch_guard();
commit;
