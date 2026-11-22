-- 0021 광고 집행 기간·날짜별 최대 청구액·정기 감시 (PM 11/22 P0 2건). 가상 DB 시험만, 실제 광고 API·지출 없음.
-- P0-1 원장≠실제 지출: launch 때 집행 기간(오늘~종료일, 최대 3개 날짜)의 날짜별 최대 청구 가능액(= 승인액: 매체 일예산 승인액÷2 × Google 2배)을
--      core.ad_exposure에 미리 기록하고, 계정 전체 날짜별 1만·누적 3만을 그 최대값으로 판정한다(넘길 가능성이 있으면 차단).
-- P0-2 종료 장치 없음: 종료일은 DB가 정한다 — min(오늘+2, 승인 만료 시각이 속한 날짜−1). 종료일 다음 날 0시(KST)가 승인 만료 이전이라
--      매체 종료일(end_date_time 23:59:59)이 승인보다 먼저 끝난다. 72시간 승인이 4개 날짜에 걸쳐도 집행은 최대 3개 날짜.
--      정기 감시(app_ad_monitor 전용 함수)가 만료·초과·불명을 보고 중지하며, 최근 2시간 안에 정상 감시 기록이 없으면 새 집행을 막는다.
begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_ad_monitor') then
    create role app_ad_monitor nologin;  -- 정기 감시 함수 3개만 실행. 테이블 권한 없음
  end if;
end $$;
grant app_ad_monitor to app_server;

create table if not exists core.ad_exposure (
  request_key  text not null check (request_key ~ '^[A-Za-z0-9-]{16,64}$'),
  serve_date   date not null,
  campaign_key text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  approval_id  uuid not null references core.ad_budget_approvals (id),
  max_krw      int  not null check (max_krw between 1 and 10000),
  created_at   timestamptz not null default now(),
  primary key (request_key, serve_date)
);
create index if not exists ad_exposure_date on core.ad_exposure (serve_date);
create table if not exists core.ad_monitor_runs (
  id      bigint generated always as identity primary key,
  ran_at  timestamptz not null default now(),
  ok      boolean not null,
  detail  jsonb not null
);
create or replace function core.ad_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'AD_APPEND_ONLY' using errcode = '42501';
end
$$;
drop trigger if exists ad_exposure_guard on core.ad_exposure;
create trigger ad_exposure_guard before update or delete on core.ad_exposure for each row execute function core.ad_append_only();
drop trigger if exists ad_monitor_runs_guard on core.ad_monitor_runs;
create trigger ad_monitor_runs_guard before update or delete on core.ad_monitor_runs for each row execute function core.ad_append_only();
alter table core.ad_exposure enable row level security;
alter table core.ad_exposure force row level security;
alter table core.ad_monitor_runs enable row level security;
alter table core.ad_monitor_runs force row level security;

-- 계정 날짜별·누적 최대 청구 가능액: 집행 기간 기록(exposure) + 기간 기록이 없는 예전 원장(0020 이전 방식)
create or replace function core.ad_account_day(p_day date) returns int
language sql stable set search_path = '' as $$  -- 호출자(fideon_api 소유 api 함수) 권한으로 읽는다(RLS 정책 fideon_api_all)
  select (coalesce((select sum(x.max_krw) from core.ad_exposure x where x.serve_date = p_day), 0)
        + coalesce((select sum(l.amount_krw) from core.ad_spend_ledger l
                    where l.spend_date = p_day and not exists (select 1 from core.ad_exposure x where x.request_key = l.request_key)), 0))::int
$$;
create or replace function core.ad_account_total() returns int
language sql stable set search_path = '' as $$
  select (coalesce((select sum(x.max_krw) from core.ad_exposure x), 0)
        + coalesce((select sum(l.amount_krw) from core.ad_spend_ledger l
                    where not exists (select 1 from core.ad_exposure x where x.request_key = l.request_key)), 0))::int
$$;

-- 집행 종료일: least(오늘+2, 승인 만료 시각(KST)이 속한 날짜−1). 결과가 오늘보다 이르면 집행 불가(승인 기간 부족)
create or replace function core.ad_window_end(p_today date, p_valid_until timestamptz) returns date
language sql immutable set search_path = '' as $$
  select least(p_today + 2, (p_valid_until at time zone 'Asia/Seoul')::date - 1)
$$;

-- 기존 지출 판정(0020)도 같은 계정 합계를 쓴다(집행 기간 기록 포함)
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

-- 집행용 지출 판정: 종료일을 DB가 정하고, 기간 전체 날짜별 최대 청구액으로 캠페인·계정 한도를 판정한다
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

-- 성과 초과 판정: 그날 원장 또는 집행 기간 최대 청구액 중 큰 값과 비교(기간 2·3일째 정상 지출을 초과로 오판하지 않음)
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
  select greatest(coalesce((select sum(l.amount_krw) from core.ad_spend_ledger l where l.campaign_key = p_campaign and l.spend_date = p_day), 0),
                  coalesce((select sum(x.max_krw) from core.ad_exposure x where x.campaign_key = p_campaign and x.serve_date = p_day), 0))::int into v_ledger;  -- 0021: 집행 기간 날짜별 최대 청구액 포함
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

-- 정기 감시 대상: 열린 launch(requested·active·unknown) + 활성 승인 만료 시각 + 기간 최대 청구액. 개인정보 없음
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

-- 감시 중지: 활성 승인 철회(모든 새 지출 차단) → 매체 중지 성공이면 launch paused, 실패면 중지 실패 경고(계정 전체 STOP_PENDING)
create or replace function api.ad_monitor_stop(p_campaign text, p_code text, p_paused boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_revoked int;
  v_alert   boolean := false;
begin
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or p_code is null or p_code !~ '^[A-Z_]{2,40}$' or p_paused is null then
    raise exception 'INVALID_MONITOR' using errcode = '22023';
  end if;
  update core.ad_budget_approvals set state = 'revoked', revoked_by = null, revoked_at = now(), revoke_reason = '정기 감시 중지: ' || p_code
   where campaign_key = p_campaign and state = 'active';
  get diagnostics v_revoked = row_count;
  if p_paused then
    update core.ad_launches set state = 'paused' where campaign_key = p_campaign and state = 'active';
  elsif not exists (select 1 from core.ad_alerts al where al.campaign_key = p_campaign and al.state = 'open') then
    insert into core.ad_alerts (campaign_key, kind, detail, created_by)
    values (p_campaign, 'stop_failed', jsonb_build_object('trigger', 'monitor', 'code', p_code, 'paused', false), '00000000-0000-4000-8000-00000000ad00');
    v_alert := true;
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (null, 'ad.monitor_stop', 'ad_campaign', null, p_code, jsonb_build_object('campaign', p_campaign, 'revoked', v_revoked, 'paused', p_paused, 'alert', v_alert));
  return jsonb_build_object('revoked', v_revoked, 'paused', p_paused, 'alert', v_alert);
end
$$;

-- 감시 실행 기록(정상·불명·실패). 새 집행은 최근 2시간 안의 마지막 기록이 정상일 때만 허용된다
create or replace function api.ad_monitor_record(p_ok boolean, p_detail jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ok is null or p_detail is null or jsonb_typeof(p_detail) <> 'object' or length(p_detail::text) > 4000 then
    raise exception 'INVALID_MONITOR' using errcode = '22023';
  end if;
  insert into core.ad_monitor_runs (ok, detail) values (p_ok, p_detail);
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (null, case when p_ok then 'ad.monitor_ok' else 'ad.monitor_alert' end, 'ad_monitor', null, null, p_detail);
end
$$;

commit;
