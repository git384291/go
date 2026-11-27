-- 0013 롤백: 경고·AI 한도 설정 함수 삭제, 승인·지출 판정 함수는 0010 정의로 되돌린다. 경고 기록은 삭제 전에 보관 테이블로 옮긴다(덮어쓰지 않음: 이미 있으면 실패).
-- 감사 로그는 그대로 남는다. 복구: 0013 재적용 후 db/rollback/0013_restore.sql. 롤백 뒤 zz_grants.sql도 이전 버전으로 실행.
begin;
create table core.ad_alerts_rollback_archive as table core.ad_alerts;
do $$
begin
  alter table core.ad_alerts_rollback_archive enable row level security;
  alter table core.ad_alerts_rollback_archive force row level security;
  create policy fideon_api_all on core.ad_alerts_rollback_archive to fideon_api using (true) with check (true);
  revoke all on core.ad_alerts_rollback_archive from public;
end $$;
drop function if exists api.ai_budget_limit_set(uuid, uuid, text, int, text);
drop function if exists api.ai_budget_limit_get(uuid, uuid, text);
drop function if exists api.ad_alert_list(uuid, uuid, text, int);
drop function if exists api.ad_alert_resolve(uuid, uuid, text, uuid, text);
drop function if exists api.ad_alert_open(uuid, uuid, text, text, jsonb);
create or replace function api.ad_budget_approve(p_actor uuid, p_session uuid, p_token text, p_campaign text,
    p_daily int, p_total int, p_valid_until timestamptz, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_id    uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_daily is null or p_daily not between 1 and 10000
     or p_total is null or p_total not between 1 and 30000 or p_total < p_daily
     or p_valid_until is null or p_valid_until <= now() or p_valid_until > now() + interval '3 days' then
    raise exception 'INVALID_BUDGET' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:' || p_campaign, 0));
  update core.ad_budget_approvals
     set state = 'revoked', revoked_by = v_staff.user_id, revoked_at = now(), revoke_reason = '새 승인으로 교체'
   where campaign_key = p_campaign and state = 'active';
  insert into core.ad_budget_approvals (campaign_key, daily_cap_krw, total_cap_krw, valid_until, approved_by, reason)
  values (p_campaign, p_daily, p_total, p_valid_until, v_staff.user_id, btrim(p_reason))
  returning id into v_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.budget_approve', 'ad_budget_approval', v_id, btrim(p_reason),
          jsonb_build_object('campaign', p_campaign, 'daily_cap_krw', p_daily, 'total_cap_krw', p_total, 'valid_until', p_valid_until));
  return v_id;
end
$$;

create or replace function api.ad_spend_request(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_amount int, p_request_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff  core.staff;
  v_app    core.ad_budget_approvals;
  v_today  date := (now() at time zone 'Asia/Seoul')::date;
  v_day    int;
  v_total  int;
  v_reason text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_amount is null or p_amount not between 1 and 10000
     or p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'INVALID_SPEND' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:' || p_campaign, 0));

  if exists (select 1 from core.ad_spend_ledger l where l.request_key = p_request_key) then
    v_reason := 'DUPLICATE_REQUEST';
  else
    select * into v_app from core.ad_budget_approvals a where a.campaign_key = p_campaign and a.state = 'active';
    if not found then
      v_reason := 'NO_APPROVAL';
    elsif v_app.valid_from > now() or v_app.valid_until <= now() then
      v_reason := 'APPROVAL_EXPIRED';
    else
      select coalesce(sum(l.amount_krw), 0) into v_day from core.ad_spend_ledger l where l.campaign_key = p_campaign and l.spend_date = v_today;
      select coalesce(sum(l.amount_krw), 0) into v_total from core.ad_spend_ledger l where l.approval_id = v_app.id;
      if v_day + p_amount > v_app.daily_cap_krw then
        v_reason := 'DAILY_CAP_EXCEEDED';
      elsif v_total + p_amount > v_app.total_cap_krw then
        v_reason := 'TOTAL_CAP_EXCEEDED';
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (v_staff.user_id, 'ad.spend_blocked', 'ad_budget_approval', v_app.id, v_reason,
            jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount));
    return jsonb_build_object('decision', 'BLOCK', 'reason', v_reason);
  end if;

  insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
  values (p_campaign, v_app.id, v_today, p_amount, p_request_key, v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.spend_allow', 'ad_budget_approval', v_app.id, null,
          jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount, 'spent_today', v_day + p_amount, 'spent_total', v_total + p_amount));
  return jsonb_build_object('decision', 'ALLOW', 'reason', null,
    'spent_today', v_day + p_amount, 'daily_cap_krw', v_app.daily_cap_krw,
    'spent_total', v_total + p_amount, 'total_cap_krw', v_app.total_cap_krw,
    'warn', (v_day + p_amount) >= v_app.daily_cap_krw * 0.8 or (v_total + p_amount) >= v_app.total_cap_krw * 0.8);
end
$$;

drop table core.ad_alerts;
drop function if exists core.ad_alert_guard();
commit;
