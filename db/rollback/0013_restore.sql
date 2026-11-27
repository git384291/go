-- 0013 롤백 뒤 복구: 0013_ad_alerts_ai_limit.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다.
\set ON_ERROR_STOP 1
begin;
insert into core.ad_alerts (id, campaign_key, kind, detail, state, created_by, created_at, resolved_by, resolved_at, resolve_note)
  select a.id, a.campaign_key, a.kind, a.detail, 'open', a.created_by, a.created_at, null, null, null from core.ad_alerts_rollback_archive a order by a.created_at on conflict (id) do nothing;
update core.ad_alerts t set state = 'resolved', resolved_by = a.resolved_by, resolved_at = a.resolved_at, resolve_note = a.resolve_note
  from core.ad_alerts_rollback_archive a where t.id = a.id and a.state = 'resolved' and t.state = 'open';
select (select count(*) from core.ad_alerts) as alerts;
commit;
