-- 0010 롤백 뒤 복구: 0010_ad_budget.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다.
\set ON_ERROR_STOP 1
begin;
insert into core.ad_budget_approvals (id, campaign_key, daily_cap_krw, total_cap_krw, valid_from, valid_until, state, approved_by, reason, created_at, revoked_by, revoked_at, revoke_reason)
  select a.id, a.campaign_key, a.daily_cap_krw, a.total_cap_krw, a.valid_from, a.valid_until, a.state, a.approved_by, a.reason, a.created_at, a.revoked_by, a.revoked_at, a.revoke_reason
  from core.ad_budget_approvals_rollback_archive a on conflict (id) do nothing;
insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by, created_at)
  overriding system value
  select l.campaign_key, l.approval_id, l.spend_date, l.amount_krw, l.request_key, l.recorded_by, l.created_at
  from core.ad_spend_ledger_rollback_archive l order by l.id on conflict (request_key) do nothing;
select (select count(*) from core.ad_budget_approvals) as approvals, (select count(*) from core.ad_spend_ledger) as ledger;
commit;
