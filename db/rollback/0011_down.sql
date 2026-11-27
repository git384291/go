-- 0011 롤백: 광고 성과·AI 사용료 객체 삭제. 성과·사용 원장·한도 설정은 삭제 전에 보관 테이블로 옮긴다(덮어쓰지 않음: 이미 있으면 실패).
-- 감사 로그는 그대로 남는다. 복구: 0011 재적용 후 db/rollback/0011_restore.sql. 롤백 뒤 zz_grants.sql도 이전 버전으로 실행.
begin;
create table core.ad_performance_rollback_archive as table core.ad_performance;
create table core.ai_usage_ledger_rollback_archive as table core.ai_usage_ledger;
create table core.ai_budget_config_rollback_archive as table core.ai_budget_config;
do $$
declare t text;
begin
  foreach t in array array['ad_performance_rollback_archive', 'ai_usage_ledger_rollback_archive', 'ai_budget_config_rollback_archive'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('create policy fideon_api_all on core.%I to fideon_api using (true) with check (true)', t);
    execute format('revoke all on core.%I from public', t);
  end loop;
end $$;
drop function if exists api.ai_budget_reserve(int);
drop function if exists api.ad_funnel(uuid, uuid, text, date, date);
drop function if exists api.ad_performance_record(uuid, uuid, text, text, date, int, int, int, text);
drop table core.ai_usage_ledger;
drop table core.ai_budget_config;
drop table core.ad_performance;
drop function if exists core.ad_ai_guard();
commit;
