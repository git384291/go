-- 0030: AI 확정 금액 상한 = 예약 금액(PM 11/24 AI 비용 하드 한도 최종검증 B4). **운영 적용은 PM 승인 전 금지.**
--  - 결함(재현 D16): ai_budget_confirm이 예약 금액과 무관하게 1~1,000원을 받아, 10원 예약 뒤 900원 확정 → 한도 밖 사용액이 기록됐다.
--  - 수정: 확정 금액이 예약 금액보다 크면 거부(false). 거부된 예약은 미정산으로 남아 예약 전액으로 센다(0028 core.ai_spent, 보수적).
--  - 나머지(서명·권한·1원 하한·예약당 1번)는 0028 그대로.
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
  if v_cost is null or p_actual > v_cost then
    return false;  -- 없는 예약·예약 초과 확정 거부
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'confirm', p_actual)
  on conflict (reservation_id) do nothing;
  return found;
end
$$;

commit;
