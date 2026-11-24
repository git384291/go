-- 0033: 불확실 정산 금액 지정(PM 11/24 ④ 보완). **운영 적용은 PM 승인 전 금지.**
--  - 0028 api.ai_budget_uncertain(id)는 시간 초과 등 과금 불확실 건을 "예약 전액"으로 닫는다. 상담 예약은 재시도 2회분(6원)인데,
--    시간 초과로 실제로 1회만 보냈어도 6원이 잡혔다(보낸 적 없는 재시도분까지 사용액으로 셈).
--  - 새 2인자 api.ai_budget_uncertain(id, 금액): 금액 = 1원 이상·예약 이하로 잘라 '불확실'로 닫는다(대표 조정 흐름 0028 그대로).
--    앱은 "보낸 횟수 × 1회 최대 비용"(1회 최대 = 입력·출력 토큰 상한 × 확인 단가, 실제 과금의 상한)을 넘긴다.
--  - 기존 1인자는 그대로(예약 전액). 같은 예약은 한 번만 닫힌다(on conflict do nothing, 0028과 동일).
begin;

create or replace function api.ai_budget_uncertain(p_id bigint, p_amount int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_cost int;
begin
  if p_amount is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select u.cost_krw into v_cost from core.ai_usage_ledger u where u.id = p_id;
  if v_cost is null then
    return false;
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'uncertain', least(v_cost, greatest(1, p_amount)))
  on conflict (reservation_id) do nothing;
  return found;
end
$$;

commit;
