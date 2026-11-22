-- 0021 롤백: 집행 기간·정기 감시 함수 제거, 0020 지출 판정·0011 성과 판정 복원. 집행 기간·감시 기록 테이블은 보관용으로 남긴다(삭제하지 않음).
begin;
drop function if exists api.ad_spend_request_window(uuid, uuid, text, text, int, text);
drop function if exists api.ad_monitor_targets();
drop function if exists api.ad_monitor_stop(text, text, boolean);
drop function if exists api.ad_monitor_record(boolean, jsonb);
commit;
\ir ../migrations/0020_ad_account_caps.sql

-- 0011 성과 판정(원장만 비교) 복원
create or replace function api.ad_performance_record(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_day date,
    p_impressions int, p_clicks int, p_cost int, p_source text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff  core.staff;
  v_ledger int;
  v_over   boolean;
  v_id     bigint;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_day is null or p_day > (now() at time zone 'Asia/Seoul')::date or p_day < date '2000-01-01'
     or p_impressions is null or p_impressions < 0 or p_clicks is null or p_clicks < 0 or p_clicks > p_impressions
     or p_cost is null or p_cost < 0 or p_cost > 100000
     or p_source is null or p_source not in ('mock', 'platform') then
    raise exception 'INVALID_PERFORMANCE' using errcode = '22023';
  end if;
  select coalesce(sum(l.amount_krw), 0) into v_ledger from core.ad_spend_ledger l where l.campaign_key = p_campaign and l.spend_date = p_day;
  v_over := p_cost > v_ledger;
  insert into core.ad_performance (campaign_key, day, impressions, clicks, cost_krw, source, over_ledger, recorded_by)
  values (p_campaign, p_day, p_impressions, p_clicks, p_cost, p_source, v_over, v_staff.user_id)
  on conflict (campaign_key, day, source) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('recorded', false, 'over_ledger', null);
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, case when v_over then 'ad.performance_overspend' else 'ad.performance_collect' end, 'ad_performance', null, null,
          jsonb_build_object('campaign', p_campaign, 'day', p_day, 'cost_krw', p_cost, 'ledger_krw', v_ledger, 'source', p_source));
  return jsonb_build_object('recorded', true, 'over_ledger', v_over);
end
$$;
