-- 0012 롤백 뒤 복구: 0012_consult_events_ai_confirm.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다.
\set ON_ERROR_STOP 1
begin;
insert into core.consult_events (session_key, campaign_key, day, created_at)
  select a.session_key, a.campaign_key, a.day, a.created_at from core.consult_events_rollback_archive a order by a.id on conflict (session_key) do nothing;
insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw, created_at)
  select a.reservation_id, a.kind, a.actual_cost_krw, a.created_at from core.ai_usage_closures_rollback_archive a on conflict (reservation_id) do nothing;
select (select count(*) from core.consult_events) as consults, (select count(*) from core.ai_usage_closures) as settlements;
commit;
