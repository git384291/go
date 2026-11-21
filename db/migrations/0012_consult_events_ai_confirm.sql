-- 0012: 상담 시작 집계 + AI 비용 예약·확정·취소 (PM 11/21). 실제 광고 집행·외부 AI 호출 없음.
--  - core.consult_events: 상담 창 '시작' 건수(개인정보 없음). 브라우저가 만든 무작위 세션 키당 1건(멱등), 캠페인 키는 선택.
--    api.consult_event_record(app_public)가 기록하고, api.ad_funnel_full이 노출→클릭→상담→접수를 한 번에 센다(기존 api.ad_funnel은 그대로 둔다).
--  - AI 비용: 0011의 예약 원장(ai_usage_ledger)에 '정산' 기록을 덧붙인다(확정=실제 비용, 취소=0). 정산이 없는 예약은 예약 비용 전액으로 센다(보수적).
--    사용액 = 취소 0, 확정 실제 비용, 미정산 예약 비용의 합. 정산은 예약당 1번만(추가 전용).
begin;

create table core.consult_events (
  id           bigint generated always as identity primary key,
  session_key  text not null unique check (session_key ~ '^[A-Za-z0-9-]{16,64}$'),
  campaign_key text check (campaign_key is null or campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  day          date not null default (now() at time zone 'Asia/Seoul')::date,
  created_at   timestamptz not null default now()
);
create index consult_events_day on core.consult_events (day, campaign_key);

create table core.ai_usage_closures (
  reservation_id  bigint primary key references core.ai_usage_ledger (id),
  kind            text not null check (kind in ('confirm', 'cancel')),
  actual_cost_krw int  not null check (actual_cost_krw between 0 and 1000),
  created_at      timestamptz not null default now(),
  check (kind = 'confirm' or actual_cost_krw = 0)
);
create trigger consult_events_guard before update or delete on core.consult_events for each row execute function core.ad_ai_guard();
create trigger ai_usage_closures_guard before update or delete on core.ai_usage_closures for each row execute function core.ad_ai_guard();

create or replace function api.consult_event_record(p_session text, p_campaign text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_session is null or p_session !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'INVALID_SESSION' using errcode = '22023';
  end if;
  insert into core.consult_events (session_key, campaign_key)
  values (p_session, case when p_campaign ~ '^[a-z0-9][a-z0-9_-]{0,63}$' then p_campaign else null end)
  on conflict (session_key) do nothing;
end
$$;

create or replace function api.ad_funnel_full(p_actor uuid, p_session uuid, p_token text, p_from date, p_to date)
returns table (campaign_key text, impressions bigint, clicks bigint, cost_krw bigint, ledger_krw bigint, consults bigint, leads bigint, overspend_days bigint)
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
      select c.campaign_key from core.consult_events c where c.campaign_key is not null and c.day between p_from and p_to
      union
      select l.utm_campaign from core.leads l
       where l.utm_campaign is not null and (l.created_at at time zone 'Asia/Seoul')::date between p_from and p_to
    )
    select k.campaign_key,
           coalesce((select sum(p.impressions) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to), 0)::bigint,
           coalesce((select sum(p.clicks) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to), 0)::bigint,
           coalesce((select sum(p.cost_krw) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to), 0)::bigint,
           coalesce((select sum(s.amount_krw) from core.ad_spend_ledger s where s.campaign_key = k.campaign_key and s.spend_date between p_from and p_to), 0)::bigint,
           (select count(*) from core.consult_events c where c.campaign_key = k.campaign_key and c.day between p_from and p_to)::bigint,
           (select count(*) from core.leads l where l.utm_campaign = k.campaign_key and (l.created_at at time zone 'Asia/Seoul')::date between p_from and p_to)::bigint,
           (select count(*) from core.ad_performance p where p.campaign_key = k.campaign_key and p.day between p_from and p_to and p.over_ledger)::bigint
      from keys k
     order by k.campaign_key
     limit 200;
end
$$;

-- 예약: 사용액(취소 0·확정 실제 비용·미정산 예약 비용)에 비용을 더해 한도 이하일 때만 원장에 올리고 예약 번호를 돌려준다. 거부는 null.
create or replace function api.ai_budget_hold(p_cost int)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_month text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM');
  v_limit int;
  v_used  int;
  v_id    bigint;
begin
  if p_cost is null or p_cost not between 1 and 1000 then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select c.monthly_limit_krw into v_limit from core.ai_budget_config c where c.singleton;
  select coalesce(sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end), 0) into v_used
    from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id where u.month = v_month;
  if v_limit is null or v_used + p_cost > v_limit then
    return null;
  end if;
  insert into core.ai_usage_ledger (month, cost_krw) values (v_month, p_cost) returning id into v_id;
  return v_id;
end
$$;

create or replace function api.ai_budget_reserve(p_cost int)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  return api.ai_budget_hold(p_cost) is not null;
end
$$;

-- 확정: 실제 비용으로 정산(예약당 1번). 이미 정산됐거나 없는 예약은 false.
create or replace function api.ai_budget_confirm(p_id bigint, p_actual int)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_id is null or p_actual is null or p_actual not between 0 and 1000 then
    return false;
  end if;
  if not exists (select 1 from core.ai_usage_ledger u where u.id = p_id) then
    return false;
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'confirm', p_actual)
  on conflict (reservation_id) do nothing;
  return found;
end
$$;

-- 취소: 호출하지 않은 예약을 0원으로 정산(예약당 1번).
create or replace function api.ai_budget_release(p_id bigint)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_id is null or not exists (select 1 from core.ai_usage_ledger u where u.id = p_id) then
    return false;
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'cancel', 0)
  on conflict (reservation_id) do nothing;
  return found;
end
$$;

commit;
