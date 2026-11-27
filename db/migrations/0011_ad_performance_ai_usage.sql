-- 0011: 광고 성과 수집·분석 + AI 사용료 DB 집계 (PM 11/21). 실제 광고 집행·외부 AI 호출 없음.
--  - core.ad_performance: 광고 플랫폼(지금은 무료 모의)이 보고한 일별 노출·클릭·광고비. 추가 전용, 같은 (캠페인·날짜·출처)는 한 번만 기록(멱등).
--    보고 광고비가 그날 승인 원장 합계보다 크면 over_ledger로 표시하고 감사 기록(ad.performance_overspend)을 남긴다(거부하지 않고 드러낸다).
--  - api.ad_funnel: 캠페인별 노출→클릭→접수(utm_campaign 일치) 합계. owner·reviewer. 개인정보는 읽지 않고 건수만 센다.
--  - AI 사용료: core.ai_budget_config(월 한도, 기본 0원 = 호출 금지) + core.ai_usage_ledger(추가 전용).
--    api.ai_budget_reserve(비용): 호출 '전에' 예약한다(한도 초과면 false). REV-004 SEC-04에 따라 app_public이 아닌 전용 역할 app_ai만 실행한다.
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_ai') then
    create role app_ai nologin;  -- AI 사용료 예약 함수 1개만 실행. 테이블 권한 없음
  end if;
end
$$;
grant app_ai to app_server;

create table core.ad_performance (
  id           bigint generated always as identity primary key,
  campaign_key text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  day          date not null,
  impressions  int  not null check (impressions between 0 and 100000000),
  clicks       int  not null check (clicks between 0 and 100000000),
  cost_krw     int  not null check (cost_krw between 0 and 100000),
  source       text not null check (source in ('mock', 'platform')),
  over_ledger  boolean not null,
  recorded_by  uuid not null,
  created_at   timestamptz not null default now(),
  check (clicks <= impressions),
  unique (campaign_key, day, source)
);

create table core.ai_budget_config (
  singleton         boolean primary key default true check (singleton),
  monthly_limit_krw int not null default 0 check (monthly_limit_krw between 0 and 1000000),
  updated_at        timestamptz not null default now()
);
insert into core.ai_budget_config (singleton, monthly_limit_krw) values (true, 0);

create table core.ai_usage_ledger (
  id         bigint generated always as identity primary key,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  cost_krw   int  not null check (cost_krw between 1 and 1000),
  created_at timestamptz not null default now()
);
create index ai_usage_ledger_month on core.ai_usage_ledger (month);

create or replace function core.ad_ai_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'APPEND_ONLY' using errcode = '42501';
end
$$;
create trigger ad_performance_guard before update or delete on core.ad_performance for each row execute function core.ad_ai_guard();
create trigger ai_usage_ledger_guard before update or delete on core.ai_usage_ledger for each row execute function core.ad_ai_guard();
-- 월 한도 설정은 삭제·복수 행 금지(수정은 관리자 DB 작업으로만)
create trigger ai_budget_config_guard before delete on core.ai_budget_config for each row execute function core.ad_ai_guard();

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

create or replace function api.ad_funnel(p_actor uuid, p_session uuid, p_token text, p_from date, p_to date)
returns table (campaign_key text, impressions bigint, clicks bigint, cost_krw bigint, ledger_krw bigint, leads bigint, overspend_days bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'INVALID_RANGE' using errcode = '22023';
  end if;
  return query
    with keys as (
      select p.campaign_key from core.ad_performance p where p.day between p_from and p_to
      union
      select l.utm_campaign from core.leads l
       where l.utm_campaign is not null and (l.created_at at time zone 'Asia/Seoul')::date between p_from and p_to
    )
    select k.campaign_key,
           coalesce((select sum(p.impressions) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to), 0)::bigint,
           coalesce((select sum(p.clicks) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to), 0)::bigint,
           coalesce((select sum(p.cost_krw) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to), 0)::bigint,
           coalesce((select sum(s.amount_krw) from core.ad_spend_ledger s where s.campaign_key = k.campaign_key and s.spend_date between p_from and p_to), 0)::bigint,
           (select count(*) from core.leads l where l.utm_campaign = k.campaign_key and (l.created_at at time zone 'Asia/Seoul')::date between p_from and p_to)::bigint,
           (select count(*) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to and p.over_ledger)::bigint
      from keys k
     order by k.campaign_key
     limit 200;
end
$$;

-- AI 사용료 예약: 비용을 '쓰기 전에' 원장에 올린다. 한도 0원(기본)·초과·입력 오류는 false(= 호출 금지).
create or replace function api.ai_budget_reserve(p_cost int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_month text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM');
  v_limit int;
  v_used  int;
begin
  if p_cost is null or p_cost not between 1 and 1000 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select c.monthly_limit_krw into v_limit from core.ai_budget_config c where c.singleton;
  select coalesce(sum(u.cost_krw), 0) into v_used from core.ai_usage_ledger u where u.month = v_month;
  if v_limit is null or v_used + p_cost > v_limit then
    return false;
  end if;
  insert into core.ai_usage_ledger (month, cost_krw) values (v_month, p_cost);
  return true;
end
$$;

commit;
