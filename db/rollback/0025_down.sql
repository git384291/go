-- 0025 롤백: 새 함수(멱등 예약·일 한도·초과 잠금) 제거, 예약·확정 판정은 0012 정의로 되돌린다.
-- 테이블·열(일 한도·원장 날짜/키·초과 기록·해제 기록)은 남긴다(추가 전용 기록 보존, 개인정보 없음). 다시 적용하면 그대로 이어 쓴다.
begin;
drop function if exists api.ai_budget_hold_keyed(int, text, text);
drop function if exists api.ai_budget_daily_limit_set(uuid, uuid, text, int, text);
drop function if exists api.ai_budget_guard_get(uuid, uuid, text);
drop function if exists api.ai_budget_overage_resolve(uuid, uuid, text, text);
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

commit;
