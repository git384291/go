-- 0027 AI 사용료 확정 상한: 예약 금액보다 큰 확정 거부(10원 예약 → 900원 확정 = 거부), 정상 정산·기존 규칙 유지. 가상 데이터만.
-- 0026 시험(99_ai_cost_hardlimit)의 도우미(test.set_limits·test.spent_now·test.hid)를 그대로 쓴다.
\set ON_ERROR_STOP 1
reset role;
select test.set_limits(100000, 100000, 100000, 100000);
create temp table t_cc as select test.spent_now(repeat('e1', 32)) as s0;
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(10, 'req-cc-0000000000001', repeat('e1', 32)) is not null)::text$$, 'true', 'CC1 10원 예약');
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-cc-0000000000001'), 900)::text$$, 'false', 'CC2 10원 예약 → 900원 확정 거부');
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-cc-0000000000001'), 11)::text$$, 'false', 'CC2b 예약보다 1원 큰 확정도 거부');
reset role;
select test.expect_eq($$select count(*)::text from core.ai_usage_closures where reservation_id = test.hid('req-cc-0000000000001')$$, '0', 'CC3 거부된 확정은 정산 기록 0건(미정산 = 예약 10원 전액으로 셈)');
select test.expect_eq($$select (split_part(test.spent_now(repeat('e1', 32)), '|', 3)::int - split_part((select s0 from t_cc), '|', 3)::int)::text$$, '10', 'CC3b 사용액 증가는 예약 금액 10원뿐(900원 아님)');
set role app_ai;
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-cc-0000000000001'), 10)::text$$, 'true', 'CC4 예약 금액과 같은 확정은 허용');
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-cc-0000000000001'), 5)::text$$, 'false', 'CC4b 같은 예약 재정산 불가(기존 규칙)');
select test.expect_eq($$select (api.ai_budget_hold(10, 'req-cc-0000000000002', repeat('e1', 32)) is not null)::text$$, 'true', 'CC5 10원 예약');
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-cc-0000000000002'), 3)::text$$, 'true', 'CC5b 예약보다 작은 확정 허용(정상 정산)');
reset role;
select test.expect_eq($$select (split_part(test.spent_now(repeat('e1', 32)), '|', 3)::int - split_part((select s0 from t_cc), '|', 3)::int)::text$$, '13', 'CC5c 사용액 = 10 + 3원(실제 금액으로 정산)');
set role app_ai;
select test.expect_eq($$select (api.ai_budget_confirm(test.hid('req-cc-0000000000002'), 0) or api.ai_budget_confirm(999999999, 1) or api.ai_budget_confirm(null, 1) or api.ai_budget_confirm(test.hid('req-cc-0000000000002'), 1001))::text$$, 'false', 'CC6 0원·없는 예약·null·범위 밖은 기존처럼 false');
select test.expect_eq($$select (api.ai_budget_hold(10, 'req-cc-0000000000003', repeat('e1', 32)) is not null)::text$$, 'true', 'CC7 예약');
select test.expect_eq($$select api.ai_budget_uncertain(test.hid('req-cc-0000000000003'))::text || api.ai_budget_confirm(test.hid('req-cc-0000000000003'), 5)::text$$, 'truefalse', 'CC7b 불확실 정산된 예약은 확정 불가(기존 규칙)');
reset role;
set role app_public;
select test.expect_error($$select api.ai_budget_confirm(1, 1)$$, '42501', 'CC8 app_public은 확정 실행 불가(권한 유지)');
reset role;
update core.ai_budget_config set paused = false, monthly_limit_krw = 0, daily_limit_krw = 0, scope_daily_limit_krw = 0, scope_monthly_limit_krw = 0, max_inflight = 0 where singleton;
