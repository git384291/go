-- 0032 롤백: 4인자 예약을 지우고 3인자 예약을 0029 본문으로 되돌린 뒤 회선 열·설정을 지운다(원장의 다른 기록은 그대로).
begin;

drop function if exists api.ai_budget_hold(int, text, text, text);
create or replace function api.ai_budget_hold(p_cost int, p_request_id text, p_scope text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_now   timestamptz := now();
  v_month text := to_char(v_now at time zone 'Asia/Seoul', 'YYYY-MM');
  v_day   date := (v_now at time zone 'Asia/Seoul')::date;
  c       core.ai_budget_config;
  s       record;
  v_id    bigint;
begin
  if p_cost is null or p_cost not between 1 and 1000
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9-]{16,64}$'
     or p_scope is null or p_scope !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select * into c from core.ai_budget_config where singleton;
  if c is null or c.paused then
    return null;
  end if;
  if exists (select 1 from core.ai_usage_ledger u where u.request_id = p_request_id) then
    return null;  -- 같은 요청은 다시 예약·호출하지 않는다
  end if;
  if (select count(*) from core.ai_usage_ledger u left join core.ai_usage_closures x on x.reservation_id = u.id
       where x.reservation_id is null and u.created_at > v_now - interval '2 minutes') >= c.max_inflight then
    return null;  -- 동시 진행 호출 상한
  end if;
  -- 0029: 사용자별 동시 진행 상한(기본 1). 같은 사용자 키의 미정산 예약(최근 2분)이 상한 이상이면 거부. 같은 잠금 안이라 동시 요청에도 원자적
  if (select count(*) from core.ai_usage_ledger u left join core.ai_usage_closures x on x.reservation_id = u.id
       where x.reservation_id is null and u.scope_key = p_scope and u.created_at > v_now - interval '2 minutes') >= c.scope_max_inflight then
    return null;
  end if;
  select * into s from core.ai_spent(v_month, v_day, p_scope);
  if s.month_all + p_cost > c.monthly_limit_krw or s.day_all + p_cost > c.daily_limit_krw
     or s.month_scope + p_cost > c.scope_monthly_limit_krw or s.day_scope + p_cost > c.scope_daily_limit_krw then
    return null;
  end if;
  insert into core.ai_usage_ledger (month, cost_krw, scope_key, request_id, created_at)
  values (v_month, p_cost, p_scope, p_request_id, v_now) returning id into v_id;
  return v_id;
end
$$;


drop index if exists core.ai_usage_ledger_net_day;
alter table core.ai_usage_ledger drop column if exists net_key;
alter table core.ai_budget_config drop column if exists net_daily_limit_krw;

commit;
