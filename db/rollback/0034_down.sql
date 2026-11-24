-- 0034 롤백: 지출 판정 2종·감시 대상을 0021 본문으로 되돌리고, 월 예산 함수·설정 표를 지운다(원장·감사 기록은 건드리지 않는다).
begin;
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
  v_acc_day   int;
  v_acc_total int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_amount is null or p_amount not between 1 and 10000
     or p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'INVALID_SPEND' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));  -- 0020: 계정 전체 직렬화(복수 캠페인 합산 경합 방지)

  if exists (select 1 from core.ad_spend_ledger l where l.request_key = p_request_key) then
    v_reason := 'DUPLICATE_REQUEST';
  elsif exists (select 1 from core.ad_alerts al where al.state = 'open') then
    v_reason := 'STOP_PENDING';  -- 0020: 어느 캠페인이든 중지 실패 경고가 열려 있으면 계정 전체 지출 차단(fail-closed)
  elsif exists (select 1 from core.ad_launches l where l.campaign_key <> p_campaign and l.state in ('requested', 'active', 'unknown')) then
    v_reason := 'ACCOUNT_LAUNCH_OPEN';  -- 0020: 다른 캠페인이 집행 중·불명이면 차단(계정당 동시 집행 1건)
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
      else
        -- 0020: 계정 전체 합산(모든 캠페인) — 일 10,000원·누적 30,000원
        v_acc_day := core.ad_account_day(v_today);
        v_acc_total := core.ad_account_total();
        if v_acc_day + p_amount > 10000 then
          v_reason := 'ACCOUNT_DAILY_CAP_EXCEEDED';
        elsif v_acc_total + p_amount > 30000 then
          v_reason := 'ACCOUNT_TOTAL_CAP_EXCEEDED';
        end if;
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

create or replace function api.ad_spend_request_window(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_amount int, p_request_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff   core.staff;
  v_app     core.ad_budget_approvals;
  v_today   date := (now() at time zone 'Asia/Seoul')::date;
  v_end     date;
  v_days    int;
  v_d       date;
  v_camp    int;
  v_total   int;
  v_reason  text;
  v_run     core.ad_monitor_runs;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_amount is null or p_amount not between 2 and 10000
     or p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'INVALID_SPEND' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  select * into v_run from core.ad_monitor_runs r order by r.ran_at desc, r.id desc limit 1;

  if exists (select 1 from core.ad_spend_ledger l where l.request_key = p_request_key) then
    v_reason := 'DUPLICATE_REQUEST';
  elsif exists (select 1 from core.ad_alerts al where al.state = 'open') then
    v_reason := 'STOP_PENDING';
  elsif exists (select 1 from core.ad_launches l where l.campaign_key <> p_campaign and l.state in ('requested', 'active', 'unknown')) then
    v_reason := 'ACCOUNT_LAUNCH_OPEN';
  elsif v_run.id is null or v_run.ran_at < now() - interval '2 hours' then
    v_reason := 'MONITOR_STALE';  -- 정기 감시가 2시간 안에 돌지 않았으면 새 집행 금지
  elsif v_run.ok is not true then
    v_reason := 'MONITOR_NOT_OK';  -- 마지막 감시가 불명·실패면 새 집행 금지
  else
    select * into v_app from core.ad_budget_approvals a where a.campaign_key = p_campaign and a.state = 'active';
    if not found then
      v_reason := 'NO_APPROVAL';
    elsif v_app.valid_from > now() or v_app.valid_until <= now() then
      v_reason := 'APPROVAL_EXPIRED';
    else
      -- 종료일: 오늘+2와 '승인 만료 시각이 속한 날짜−1' 중 이른 날. 종료일 다음 날 0시(KST) ≤ 승인 만료
      v_end := core.ad_window_end(v_today, v_app.valid_until);
      if v_end < v_today then
        v_reason := 'APPROVAL_TOO_SHORT';
      else
        v_days := v_end - v_today + 1;
        select coalesce(sum(l.amount_krw), 0) into v_total from core.ad_spend_ledger l
          where l.approval_id = v_app.id and not exists (select 1 from core.ad_exposure x where x.request_key = l.request_key);
        v_total := v_total + coalesce((select sum(x.max_krw) from core.ad_exposure x where x.approval_id = v_app.id), 0);
        if p_amount > v_app.daily_cap_krw then
          v_reason := 'DAILY_CAP_EXCEEDED';
        elsif v_total + p_amount * v_days > v_app.total_cap_krw then
          v_reason := 'TOTAL_CAP_EXCEEDED';
        elsif core.ad_account_total() + p_amount * v_days > 30000 then
          v_reason := 'ACCOUNT_TOTAL_CAP_EXCEEDED';
        else
          for v_d in select generate_series(v_today, v_end, interval '1 day')::date loop
            select coalesce(sum(x.max_krw), 0) into v_camp from core.ad_exposure x where x.campaign_key = p_campaign and x.serve_date = v_d;
            if v_camp + p_amount > v_app.daily_cap_krw then v_reason := 'DAILY_CAP_EXCEEDED'; exit; end if;
            if core.ad_account_day(v_d) + p_amount > 10000 then v_reason := 'ACCOUNT_DAILY_CAP_EXCEEDED'; exit; end if;
          end loop;
        end if;
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (v_staff.user_id, 'ad.spend_blocked', 'ad_budget_approval', v_app.id, v_reason,
            jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount, 'window', true));
    return jsonb_build_object('decision', 'BLOCK', 'reason', v_reason);
  end if;

  insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
  values (p_campaign, v_app.id, v_today, p_amount, p_request_key, v_staff.user_id);
  insert into core.ad_exposure (request_key, serve_date, campaign_key, approval_id, max_krw)
  select p_request_key, d::date, p_campaign, v_app.id, p_amount from generate_series(v_today, v_end, interval '1 day') d;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.spend_allow', 'ad_budget_approval', v_app.id, null,
          jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount, 'start_date', v_today, 'end_date', v_end, 'max_total_krw', p_amount * v_days));
  return jsonb_build_object('decision', 'ALLOW', 'reason', null, 'start_date', v_today, 'end_date', v_end, 'days', v_days,
    'max_total_krw', p_amount * v_days, 'valid_until', v_app.valid_until);
end
$$;

create or replace function api.ad_monitor_targets()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'today', (now() at time zone 'Asia/Seoul')::date,
    'account_total_krw', core.ad_account_total(),
    'launches', coalesce((select jsonb_agg(jsonb_build_object(
        'campaign', l.campaign_key, 'state', l.state, 'external_id', l.external_id,
        'valid_until', (select a.valid_until from core.ad_budget_approvals a where a.campaign_key = l.campaign_key and a.state = 'active'),
        'end_date', (select max(x.serve_date) from core.ad_exposure x where x.request_key = l.request_key),
        'days', coalesce((select jsonb_agg(jsonb_build_object('date', x.serve_date, 'max_krw', x.max_krw) order by x.serve_date) from core.ad_exposure x where x.request_key = l.request_key), '[]'::jsonb)
      ) order by l.created_at) from core.ad_launches l where l.state in ('requested', 'active', 'unknown')), '[]'::jsonb))
$$;

drop function if exists api.ad_monthly_budget_set(uuid, uuid, text, int, int, text);
drop function if exists api.ad_monthly_budget_get(uuid, uuid, text);
drop function if exists core.ad_month_check(date, date, int);
drop function if exists core.ad_month_effective_limit();
drop function if exists core.ad_account_month(date);
drop table if exists core.ad_month_config;
drop function if exists core.ad_month_config_guard();
commit;
