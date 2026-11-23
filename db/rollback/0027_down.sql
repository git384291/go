-- 0027 롤백: 확정 함수를 0026 정의로 되돌린다(정산 기록은 그대로).
begin;
create or replace function api.ai_budget_confirm(p_id bigint, p_actual int)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_id is null or p_actual is null or p_actual not between 1 and 1000 then
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
