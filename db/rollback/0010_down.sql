-- 0010 롤백: 광고 예산 통제 함수·테이블 삭제. 승인·지출 원장은 삭제 전에 보관 테이블로 옮긴다(덮어쓰지 않음: 이미 있으면 실패).
-- 감사 로그는 추가 전용이라 그대로 남는다. 복구: 0010 재적용 후 db/rollback/0010_restore.sql. 롤백 뒤 zz_grants.sql도 이전 버전으로 실행.
begin;
create table core.ad_budget_approvals_rollback_archive as table core.ad_budget_approvals;
create table core.ad_spend_ledger_rollback_archive as table core.ad_spend_ledger;
do $$
declare t text;
begin
  foreach t in array array['ad_budget_approvals_rollback_archive', 'ad_spend_ledger_rollback_archive'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('create policy fideon_api_all on core.%I to fideon_api using (true) with check (true)', t);
    execute format('revoke all on core.%I from public', t);
  end loop;
end $$;
drop function if exists api.ad_budget_overview(uuid, uuid, text, int);
drop function if exists api.ad_spend_request(uuid, uuid, text, text, int, text);
drop function if exists api.ad_budget_revoke(uuid, uuid, text, text, text);
drop function if exists api.ad_budget_approve(uuid, uuid, text, text, int, int, timestamptz, text);
drop table core.ad_spend_ledger;
drop table core.ad_budget_approvals;
drop function if exists core.ad_budget_guard();
commit;
