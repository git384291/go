-- 0027 AI 사용료 확정 상한(PM 11/24 결함 보완). 실제 AI 호출·운영 데이터 변경 없음.
--  - 결함: 0026의 api.ai_budget_confirm은 예약 금액보다 큰 확정(예: 10원 예약 → 900원 확정)을 받아들여 사용액이 한도를 넘었다.
--  - 수정: 확정 금액은 '그 예약 금액 이하'만 허용한다. 넘으면 false(정산하지 않음) → 미정산으로 남아 예약 금액 전액으로 센다(0026 규칙 그대로).
--    한도는 예약 시점에 이미 예약 금액으로 판정했으므로, 확정이 예약을 넘지 못하면 사용액이 한도를 넘을 수 없다.
--  - 그 밖의 규칙(1~1,000원 정수, 예약당 1번, 취소·불확실 정산된 예약은 확정 불가, 반환값 boolean)은 0026과 같다.
begin;

create or replace function api.ai_budget_confirm(p_id bigint, p_actual int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_cost int;
begin
  if p_id is null or p_actual is null or p_actual not between 1 and 1000 then
    return false;
  end if;
  select u.cost_krw into v_cost from core.ai_usage_ledger u where u.id = p_id;
  if v_cost is null then
    return false;
  end if;
  if p_actual > v_cost then
    return false;   -- 예약 금액 초과 확정 거부(사용액이 예약·한도를 넘지 못하게)
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'confirm', p_actual)
  on conflict (reservation_id) do nothing;
  return found;
end
$$;

commit;
