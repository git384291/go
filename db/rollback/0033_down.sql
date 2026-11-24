-- 0033 롤백: 2인자 불확실 정산 제거(1인자 = 예약 전액은 그대로). 이미 닫힌 정산 행은 건드리지 않는다.
begin;
drop function if exists api.ai_budget_uncertain(bigint, int);
commit;
