-- 0034 광고 월 예산 하드 한도(PM 11/25). 가상 DB 시험만, 실제 Google Ads API·광고비 없음.
-- - 월 예산 기본값 0원 = 미설정 → 모든 새 광고 집행 차단(MONTHLY_BUDGET_UNSET). 금액은 PM 승인 후 대표가 설정(사유 필수·감사 기록).
-- - 월 사용액(한국 시간 달력 월): 캠페인·날짜마다 max(최대 청구 가능액(집행 기간 기록 + 예전 원장), 보고된 실제 비용)의 합.
--   보고가 없거나 늦으면 최대 청구 가능액으로 센다(미확정 지출을 0원으로 보지 않음). 늦게 들어온 보고가 더 크면 큰 값으로 센다.
-- - 판정 한도 = 월 예산 × (100 − 안전 여유%) / 100. 안전 여유 기본 20%(10~50%). 지출 집계 지연·플랫폼 초과 청구 대비.
-- - 집행 기간이 두 달에 걸치면 달마다 따로 판정. 판정은 기존 계정 잠금(adspend:account) 안에서 → 동시 요청·여러 서버도 직렬화.
-- 이 한도는 앱·DB 판정이다. Google 실제 청구가 월 예산을 절대 넘지 않는다는 보장은 아니다(지연 보고·중지 지연).
begin;

create table if not exists core.ad_month_config (
  id                smallint primary key default 1 check (id = 1),
  monthly_limit_krw int not null default 0 check (monthly_limit_krw between 0 and 1000000),
  margin_pct        int not null default 20 check (margin_pct between 10 and 50),
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);
insert into core.ad_month_config (id) values (1) on conflict (id) do nothing;
create or replace function core.ad_month_config_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'AD_MONTH_CONFIG_LOCKED' using errcode = '42501';  -- 삭제 금지(설정 행은 1개 고정)
end
$$;
drop trigger if exists ad_month_config_guard on core.ad_month_config;
create trigger ad_month_config_guard before delete on core.ad_month_config for each row execute function core.ad_month_config_guard();
alter table core.ad_month_config enable row level security;
alter table core.ad_month_config force row level security;

-- 월 사용액(p_month가 속한 KST 달력 월). 캠페인·날짜별 max(최대 청구 가능액, 보고 비용(출처 중 큰 값))의 합
create or replace function core.ad_account_month(p_month date) returns int
language sql stable set search_path = '' as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month')::date as e),
  res as (
    select x.campaign_key as c, x.serve_date as d, x.max_krw::bigint as v from core.ad_exposure x, m where x.serve_date >= m.s and x.serve_date < m.e
    union all
    select l.campaign_key, l.spend_date, l.amount_krw::bigint from core.ad_spend_ledger l, m
     where l.spend_date >= m.s and l.spend_date < m.e and not exists (select 1 from core.ad_exposure x where x.request_key = l.request_key)
  ),
  r as (select c, d, sum(v) as v from res group by c, d),
  p as (select a.campaign_key as c, a.day as d, max(a.cost_krw)::bigint as v from core.ad_performance a, m where a.day >= m.s and a.day < m.e group by a.campaign_key, a.day)
  select least(coalesce(sum(greatest(coalesce(r.v, 0), coalesce(p.v, 0))), 0), 2147483647)::int
    from r full join p on r.c = p.c and r.d = p.d
$$;

-- 판정 한도(안전 여유 적용). 설정 행이 없거나 0원이면 0(= 집행 금지)
create or replace function core.ad_month_effective_limit() returns int
language sql stable set search_path = '' as $$
  select coalesce((select (c.monthly_limit_krw::bigint * (100 - c.margin_pct) / 100)::int from core.ad_month_config c where c.id = 1), 0)
$$;

-- 집행 기간(p_start~p_end)이 걸친 달마다: 그 달 사용액 + 그 달 날짜 수 × 날짜별 최대 청구액 ≤ 판정 한도. 넘길 가능성이 있으면 차단 사유
create or replace function core.ad_month_check(p_start date, p_end date, p_amount int) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_lim  bigint := core.ad_month_effective_limit();
  v_m    date;
  v_days bigint;
begin
  if v_lim <= 0 then
    return 'MONTHLY_BUDGET_UNSET';
  end if;
  if p_start is null or p_end is null or p_end < p_start or p_amount is null or p_amount < 1 then
    return 'MONTHLY_CHECK_INVALID';
  end if;
  for v_m in select distinct date_trunc('month', g)::date from generate_series(p_start, p_end, interval '1 day') g loop
    select count(*) into v_days from generate_series(greatest(p_start, v_m), least(p_end, (v_m + interval '1 month')::date - 1), interval '1 day');
    if core.ad_account_month(v_m)::bigint + p_amount::bigint * v_days > v_lim then
      return 'MONTHLY_CAP_EXCEEDED';
    end if;
  end loop;
  return null;
end
$$;

-- 지출 판정 2종에 월 예산 판정 추가(0021 본문 + 마지막 판정 1단계)
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
  if v_reason is null then
    v_reason := core.ad_month_check(v_today, v_today, p_amount);  -- 0034: 월 예산(KST 달력 월, 안전 여유 적용)
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
  if v_reason is null then
    v_reason := core.ad_month_check(v_today, v_end, p_amount);  -- 0034: 집행 기간이 걸친 달마다 월 예산 판정
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

-- 정기 감시 대상에 이번 달 사용액·판정 한도 추가(감시가 월 예산 도달 시 열린 캠페인 중지)
create or replace function api.ad_monitor_targets()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'today', (now() at time zone 'Asia/Seoul')::date,
    'account_total_krw', core.ad_account_total(),
    'month_used_krw', core.ad_account_month((now() at time zone 'Asia/Seoul')::date),   -- 0034
    'month_limit_krw', core.ad_month_effective_limit(),                                -- 0034: 안전 여유 적용 한도(0 = 미설정)
    'launches', coalesce((select jsonb_agg(jsonb_build_object(
        'campaign', l.campaign_key, 'state', l.state, 'external_id', l.external_id,
        'valid_until', (select a.valid_until from core.ad_budget_approvals a where a.campaign_key = l.campaign_key and a.state = 'active'),
        'end_date', (select max(x.serve_date) from core.ad_exposure x where x.request_key = l.request_key),
        'days', coalesce((select jsonb_agg(jsonb_build_object('date', x.serve_date, 'max_krw', x.max_krw) order by x.serve_date) from core.ad_exposure x where x.request_key = l.request_key), '[]'::jsonb)
      ) order by l.created_at) from core.ad_launches l where l.state in ('requested', 'active', 'unknown')), '[]'::jsonb))
$$;

-- 월 예산 설정: 대표만, 사유 필수, 변경 전후 감사 기록. 지출 판정과 같은 계정 잠금으로 직렬화
create or replace function api.ad_monthly_budget_set(p_actor uuid, p_session uuid, p_token text, p_limit int, p_margin int, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   core.ad_month_config;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_limit is null or p_limit not between 0 and 1000000 or p_margin is null or p_margin not between 10 and 50
     or p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'INVALID_MONTHLY_BUDGET' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  select * into v_old from core.ad_month_config c where c.id = 1 for update;
  if not found then
    raise exception 'AD_MONTH_CONFIG_MISSING' using errcode = '55000';
  end if;
  update core.ad_month_config set monthly_limit_krw = p_limit, margin_pct = p_margin, updated_by = v_staff.user_id, updated_at = now() where id = 1;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.monthly_budget_set', 'ad_month_config', null, btrim(p_reason),
          jsonb_build_object('old', jsonb_build_object('monthly_limit_krw', v_old.monthly_limit_krw, 'margin_pct', v_old.margin_pct),
                             'new', jsonb_build_object('monthly_limit_krw', p_limit, 'margin_pct', p_margin)));
  return jsonb_build_object('monthly_limit_krw', p_limit, 'margin_pct', p_margin, 'effective_limit_krw', core.ad_month_effective_limit());
end
$$;

-- 월 예산 조회: 대표·검토자. 이번 달(KST) 사용액(미확정 = 최대 청구 가능액)과 판정 한도
create or replace function api.ad_monthly_budget_get(p_actor uuid, p_session uuid, p_token text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  c       core.ad_month_config;
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  select * into c from core.ad_month_config x where x.id = 1;
  return jsonb_build_object('month', to_char(v_today, 'YYYY-MM'), 'monthly_limit_krw', coalesce(c.monthly_limit_krw, 0), 'margin_pct', c.margin_pct,
    'effective_limit_krw', core.ad_month_effective_limit(), 'used_krw', core.ad_account_month(v_today));
end
$$;

commit;
