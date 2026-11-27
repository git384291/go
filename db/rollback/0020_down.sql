-- 0020 롤백: api.ad_spend_request를 0013 정의(캠페인 단위 한도만)로 되돌린다. 데이터 변경 없음.

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
  elsif exists (select 1 from core.ad_alerts al where al.campaign_key = p_campaign and al.state = 'open') then
    v_reason := 'STOP_PENDING';  -- 0013: 중지 실패 경고가 열려 있는 동안 모든 지출 차단
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
