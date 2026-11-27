-- 0011 롤백 뒤 복구: 0011_ad_performance_ai_usage.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다.
\set ON_ERROR_STOP 1
begin;
insert into core.ad_performance (campaign_key, day, impressions, clicks, cost_krw, source, over_ledger, recorded_by, created_at)
  select a.campaign_key, a.day, a.impressions, a.clicks, a.cost_krw, a.source, a.over_ledger, a.recorded_by, a.created_at
  from core.ad_performance_rollback_archive a order by a.id on conflict (campaign_key, day, source) do nothing;
insert into core.ai_usage_ledger (month, cost_krw, created_at)
  select u.month, u.cost_krw, u.created_at from core.ai_usage_ledger_rollback_archive u order by u.id;
update core.ai_budget_config c set monthly_limit_krw = a.monthly_limit_krw from core.ai_budget_config_rollback_archive a where c.singleton and a.singleton;
select (select count(*) from core.ad_performance) as performance, (select count(*) from core.ai_usage_ledger) as usage;
commit;
