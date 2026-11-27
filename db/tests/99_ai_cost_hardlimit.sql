-- 0028 AI 사용료 하드 한도: 일·사용자 한도, 긴급 차단, 멱등 요청 ID, 확정 1원 하한, 불확실 정산·조정, 권한. 가상 데이터만.
-- 시험 전 원장·정산 기준을 비우지 않는다(추가 전용). 대신 시험 전용 scope와 '오늘 사용액 기준값'을 잡고 그 위에 한도를 얹는다.
create function test.spent_now(p_scope text) returns text language sql security definer set search_path = pg_catalog as $$
  select (x.month_all || '|' || x.day_all || '|' || x.month_scope || '|' || x.day_scope)
    from core.ai_spent(to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'), (now() at time zone 'Asia/Seoul')::date, p_scope) x $$;
create function test.base(p_which int) returns int language sql security definer set search_path = pg_catalog as $$
  select split_part(test.spent_now(repeat('0', 64)), '|', p_which)::int $$;
create function test.hid(p_req text) returns bigint language sql security definer set search_path = pg_catalog as $$
  select id from core.ai_usage_ledger where request_id = p_req $$;
grant execute on function test.hid(text) to app_ai, app_staff;
-- 한도 세팅: 서비스 월·일은 '기존 사용액 + 여유', 사용자 한도는 새 scope 기준
create function test.set_limits(p_month_room int, p_day_room int, p_scope_day int, p_scope_month int) returns void language sql security definer set search_path = pg_catalog as $$
  update core.ai_budget_config set paused = false,
         monthly_limit_krw = test.base(1) + p_month_room, daily_limit_krw = test.base(2) + p_day_room,
         scope_daily_limit_krw = p_scope_day, scope_monthly_limit_krw = p_scope_month, max_inflight = 1000 where singleton $$;

-- H1 새 한도의 기본값 0원 = 호출 금지(0028 적용 직후 구성)
update core.ai_budget_config set daily_limit_krw = 0, scope_daily_limit_krw = 0, scope_monthly_limit_krw = 0, max_inflight = 1000, scope_max_inflight = 100, monthly_limit_krw = 1000000 where singleton;
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h1-0000000000001', repeat('c', 64)) is null)::text$$, 'true', 'H1 일·사용자 한도 미설정(0원)이면 월 한도가 넉넉해도 거부');
reset role;

-- H2 TEST-02 서비스 일일 한도: 여유 10원, 사용자 한도 넉넉 → 10원까지 허용, 넘으면 거부
select test.set_limits(100000, 10, 100000, 100000);
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(10, 'req-h2-0000000000001', repeat('d', 64)) is not null)::text$$, 'true', 'H2 일일 여유 10원 안 예약');
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h2-0000000000002', repeat('d', 64)) is null)::text$$, 'true', 'H2b 일일 한도 도달 뒤 1원 거부(월 한도는 여유)');
reset role;

-- H3 사용자별 일일·월간 한도: 같은 scope는 막히고 다른 scope는 통과
select test.set_limits(100000, 100000, 30, 1000);
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(30, 'req-h3-0000000000001', repeat('e', 64)) is not null)::text$$, 'true', 'H3 사용자 일일 30원 예약');
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h3-0000000000002', repeat('e', 64)) is null)::text$$, 'true', 'H3b 같은 사용자 일일 한도 초과 거부');
select test.expect_eq($$select (api.ai_budget_hold(30, 'req-h3-0000000000003', repeat('f', 64)) is not null)::text$$, 'true', 'H3c 다른 사용자는 별도 한도');
reset role;
select test.set_limits(100000, 100000, 1000, 50);
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(20, 'req-h3-0000000000004', repeat('e', 64)) is not null)::text$$, 'true', 'H3d 사용자 월 50원: 30+20=50 허용');
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h3-0000000000005', repeat('e', 64)) is null)::text$$, 'true', 'H3e 사용자 월 한도 초과 거부');
reset role;

-- H4 TEST-12 멱등: 같은 요청 ID는 한도가 남아도 다시 예약하지 않는다
select test.set_limits(100000, 100000, 1000, 1000);
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(5, 'req-h4-0000000000001', repeat('a1', 32)) is not null)::text$$, 'true', 'H4 첫 예약');
select test.expect_eq($$select (api.ai_budget_hold(5, 'req-h4-0000000000001', repeat('a1', 32)) is null)::text$$, 'true', 'H4b 같은 요청 ID 재예약 거부');
select test.expect_eq($$select (api.ai_budget_hold(5, 'req-h4-0000000000001', repeat('a2', 32)) is null)::text$$, 'true', 'H4c 다른 사용자로 같은 ID를 보내도 거부');
select test.expect_eq($$select (api.ai_budget_hold(5, 'short', repeat('a1', 32)) is null and api.ai_budget_hold(5, null, repeat('a1', 32)) is null
  and api.ai_budget_hold(5, 'req-h4-0000000000009', 'not-a-hash') is null and api.ai_budget_hold(5, 'req-h4-0000000000009', null) is null)::text$$, 'true', 'H4d 요청 ID·사용자 키 형식 오류 거부');
reset role;
select test.expect_eq($$select count(*)::text from core.ai_usage_ledger where request_id = 'req-h4-0000000000001'$$, '1', 'H4e 원장에 1건만');

-- H5 TEST-08 긴급 차단: 대표만 켠다(사유·감사 기록, 미정산 수 기록) → 예약 0건 → 끄면 다시 허용
set role app_staff;
select test.expect_error(test.adcall('reviewer', 'ai_budget_pause_set', $$true, '시험'$$), '42501', 'H5 검토자는 긴급 차단 불가');
select test.expect_error(test.adcall('owner', 'ai_budget_pause_set', $$true, ' '$$), '22023', 'H5b 사유 필수');
select test.expect_ok(test.adcall('owner', 'ai_budget_pause_set', $$true, '긴급 차단 시험'$$), 'H5c 대표 긴급 차단');
reset role;
select test.expect_eq($$select (detail->>'new_paused') || '|' || (detail ? 'unsettled_reservations')::text from core.audit_logs where action = 'ai.emergency_pause' order by id desc limit 1$$, 'true|true', 'H5d 감사 기록(진행 중 예약 수 포함)');
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h5-0000000000001', repeat('a3', 32)) is null)::text$$, 'true', 'H5e 차단 중 신규 예약 0건');
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-h4-0000000000001'), 5)::text$$, 'true', 'H5f 차단 전 진행 중 예약은 정산 가능(기록 보존)');
reset role;
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ai_budget_pause_set', $$false, '시험 종료'$$), 'H5g 차단 해제');
reset role;
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h5-0000000000002', repeat('a3', 32)) is not null)::text$$, 'true', 'H5h 해제 뒤 허용');
-- H6 확정 하한: 호출이 나간 뒤 0원 확정으로 사용액을 지울 수 없다
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-h5-0000000000002'), 0)::text$$, 'false', 'H6 0원 확정 거부');
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-h5-0000000000002'), 1)::text$$, 'true', 'H6b 1원 확정 허용');
-- H7 TEST-05 불확실 정산: 예약 전액으로 닫힌다 → 조정 전까지 전액으로 센다
select test.expect_eq($$select (api.ai_budget_hold(40, 'req-h7-0000000000001', repeat('a4', 32)) is not null)::text$$, 'true', 'H7 40원 예약');
select test.expect_eq($$select api.ai_budget_uncertain(test.hid('req-h7-0000000000001'))::text$$, 'true', 'H7b 불확실로 닫기');
select test.expect_eq($$select (api.ai_budget_uncertain(test.hid('req-h7-0000000000001')) or api.ai_budget_confirm(test.hid('req-h7-0000000000001'), 1) or api.ai_budget_release(test.hid('req-h7-0000000000001')))::text$$, 'false', 'H7c 다시 닫거나 취소(환불) 불가');
reset role;
select test.expect_eq($$select split_part(test.spent_now(repeat('a4', 32)), '|', 4)$$, '40', 'H7d 조정 전 = 예약 전액 40원');
set role app_staff;
select test.expect_error(test.adcall('reviewer', 'ai_budget_adjust', format('%s, 10, %L', test.hid('req-h7-0000000000001'), '사용량 확인')), '42501', 'H7e 검토자는 조정 불가');
select test.expect_ok(test.adcall('owner', 'ai_budget_adjust', format('%s, 12, %L', test.hid('req-h7-0000000000001'), '업체 사용량 화면 확인(가상)')), 'H7f 대표 조정 12원');
select test.expect_error(test.adcall('owner', 'ai_budget_adjust', format('%s, 0, %L', test.hid('req-h7-0000000000001'), '재조정')), '22023', 'H7g 같은 건 재조정 불가');
select test.expect_error(test.adcall('owner', 'ai_budget_adjust', format('%s, 0, %L', test.hid('req-h5-0000000000002'), '확정 건')), '22023', 'H7h 확정 건은 조정 불가');
reset role;
select test.expect_eq($$select split_part(test.spent_now(repeat('a4', 32)), '|', 4)$$, '12', 'H7i 조정 뒤 12원');
select test.expect_eq($$select (detail->>'reserved_krw') || '>' || (detail->>'actual_krw') from core.audit_logs where action = 'ai.usage_adjust' order by id desc limit 1$$, '40>12', 'H7j 조정 감사 기록');
select test.expect_error($$delete from core.ai_usage_adjustments$$, '42501', 'H7k 조정 기록 삭제 불가');

-- H8 한도 설정: 대표만, 범위·사유 검사, 감사 기록
set role app_staff;
select test.expect_error(test.adcall('editor', 'ai_budget_limits_set', $$10, 10, 10, 10, '시험'$$), '42501', 'H8 편집자 설정 불가');
select test.expect_error(test.adcall('owner', 'ai_budget_limits_set', $$-1, 10, 10, 10, '시험'$$), '22023', 'H8b 음수 거부');
select test.expect_error(test.adcall('owner', 'ai_budget_limits_set', $$100001, 10, 10, 10, '시험'$$), '22023', 'H8c 상한 초과 거부');
select test.expect_error(test.adcall('owner', 'ai_budget_limits_set', $$null, 10, 10, 10, '시험'$$), '22023', 'H8d null 거부');
select test.expect_ok(test.adcall('owner', 'ai_budget_limits_set', $$300, 30, 900, 7, '개발용 가상 한도'$$), 'H8e 대표 설정');
reset role;
select test.expect_eq($$select daily_limit_krw || '|' || scope_daily_limit_krw || '|' || scope_monthly_limit_krw || '|' || max_inflight from core.ai_budget_config where singleton$$, '300|30|900|7', 'H8f 반영');
set role app_staff;
select test.expect_error(test.adcall('owner', 'ai_budget_limits_set', $$10, 10, 10, 1001, '시험'$$), '22023', 'H8h 동시 상한 범위 밖 거부');
reset role;
select test.expect_eq($$select detail->'new'->>'daily' from core.audit_logs where action = 'ai.budget_limits_set' order by id desc limit 1$$, '300', 'H8g 감사 기록');

-- H9 권한: 앱 역할은 새 함수를 교차 실행할 수 없다
set role app_public;
select test.expect_error($$select api.ai_budget_hold(1, 'req-h9-0000000000001', repeat('a5', 32))$$, '42501', 'H9 app_public 예약 불가');
select test.expect_error($$select api.ai_budget_uncertain(1)$$, '42501', 'H9b app_public 불확실 정산 불가');
reset role;
set role app_staff;
select test.expect_error($$select api.ai_budget_hold(1, 'req-h9-0000000000002', repeat('a5', 32))$$, '42501', 'H9c app_staff 예약 불가');
reset role;
select test.adcall('owner', 'ai_budget_pause_set', $$false, '우회'$$) as h9sql \gset
set role app_ai;
select test.expect_error(:'h9sql', '42501', 'H9d app_ai는 대표 서명이 있어도 긴급 차단 변경 불가');
select test.expect_error($$select * from core.ai_spent('2026-11', current_date, null)$$, '42501', 'H9e app_ai 사용액 보조 함수 직접 실행 불가');
select test.expect_error($$update core.ai_budget_config set paused = false$$, '42501', 'H9f app_ai 설정 직접 변경 불가');
reset role;

-- H10 TEST-11 일 키는 created_at의 한국 날짜(생성 열, 수동 지정 불가)
select test.expect_eq($$select (timestamptz '2026-11-30 15:30:00+00' at time zone 'Asia/Seoul')::date::text$$, '2026-12-01', 'H10 UTC 11/30 15:30 = 한국 12/01');
select test.expect_error($$insert into core.ai_usage_ledger (month, cost_krw, day) values ('2026-11', 1, date '2000-01-01')$$, '428C9', 'H10b 일 키 직접 지정 불가(생성 열)');
select test.expect_eq($$select count(*)::text from core.ai_usage_ledger where day <> (created_at at time zone 'Asia/Seoul')::date$$, '0', 'H10c 모든 예약의 일 키 = 생성 시각의 한국 날짜');


-- H11 TEST-04 동시 요청 한도: 미정산(진행 중) 예약이 max_inflight개면 다음 예약 거부, 정산되면 다시 허용
select test.set_limits(100000, 100000, 100000, 100000);
create function test.open_recent() returns int language sql security definer set search_path = pg_catalog as $$
  select count(*)::int from core.ai_usage_ledger u left join core.ai_usage_closures x on x.reservation_id = u.id where x.reservation_id is null and u.created_at > now() - interval '2 minutes' $$;
update core.ai_budget_config set max_inflight = test.open_recent() + 2 where singleton;
set role app_ai;
select test.expect_eq($$select ((api.ai_budget_hold(1, 'req-h11-000000000001', repeat('a6', 32)) is not null) and (api.ai_budget_hold(1, 'req-h11-000000000002', repeat('a6', 32)) is not null))::text$$, 'true', 'H11 동시 상한까지 예약');
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h11-000000000003', repeat('a6', 32)) is null)::text$$, 'true', 'H11b 상한 도달 → 거부');
select test.expect_eq($$select api.ai_budget_confirm(test.hid('req-h11-000000000001'), 1)::text$$, 'true', 'H11c 1건 정산');
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h11-000000000004', repeat('a6', 32)) is not null)::text$$, 'true', 'H11d 자리 생기면 허용');
reset role;
update core.ai_budget_config set max_inflight = 0 where singleton;
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h11-000000000005', repeat('a6', 32)) is null)::text$$, 'true', 'H11e 동시 상한 0 = 호출 금지');
reset role;

-- 원상 복구: 한도 0원(기본 = 호출 금지)
update core.ai_budget_config set paused = false, monthly_limit_krw = 0, daily_limit_krw = 0, scope_daily_limit_krw = 0, scope_monthly_limit_krw = 0, max_inflight = 0 where singleton;

-- H12 (0029) 사용자별 동시 처리 1건: 같은 사용자 키의 미정산 예약이 있으면 거부, 다른 사용자는 통과, 정산 뒤 다시 허용
select test.set_limits(1000, 1000, 1000, 1000);
update core.ai_budget_config set scope_max_inflight = 1 where singleton;
select set_config('t.h12', api.ai_budget_hold(1, 'req-h12-000000000001', repeat('b7', 32))::text, false);
select test.expect_eq($$select (current_setting('t.h12') <> '')::text$$, 'true', 'H12 사용자 A 첫 예약');
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h12-000000000002', repeat('b7', 32)) is null)::text$$, 'true', 'H12b 같은 사용자 A 동시 두 번째 거부(미정산 1건)');
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h12-000000000003', repeat('b8', 32)) is not null)::text$$, 'true', 'H12c 다른 사용자 B는 허용');
select api.ai_budget_confirm(current_setting('t.h12')::bigint, 1);
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h12-000000000004', repeat('b7', 32)) is not null)::text$$, 'true', 'H12d A 정산 뒤 다시 허용');
update core.ai_budget_config set scope_max_inflight = 0 where singleton;
select test.expect_eq($$select (api.ai_budget_hold(1, 'req-h12-000000000005', repeat('b9', 32)) is null)::text$$, 'true', 'H12e 상한 0 = 호출 금지');
select test.expect_eq($$select column_default from information_schema.columns where table_schema = 'core' and table_name = 'ai_budget_config' and column_name = 'scope_max_inflight'$$, '1', 'H12f 기본값 1(PM 결정)');
-- H12 정리: 남은 예약 정산 후 원상 복구(한도 0원 = 호출 금지, 사용자 동시 상한은 기본 1) — 뒤 시험(앱 통합 E12·E15)이 기본값을 전제로 한다
select api.ai_budget_confirm(u.id, 1) from core.ai_usage_ledger u left join core.ai_usage_closures x on x.reservation_id = u.id
 where x.reservation_id is null and u.request_id like 'req-h12-%';
update core.ai_budget_config set paused = false, monthly_limit_krw = 0, daily_limit_krw = 0, scope_daily_limit_krw = 0, scope_monthly_limit_krw = 0, max_inflight = 0, scope_max_inflight = 1 where singleton;
-- H13 0033 불확실 정산 금액 지정(PM 11/24 보완): 시간 초과는 보낸 횟수 × 1회 최대 비용만(예약 전액 아님), 1원 이상·예약 이하, 한 번만
update core.ai_budget_config set paused = false, monthly_limit_krw = 1000000, daily_limit_krw = 1000000, scope_daily_limit_krw = 1000000, scope_monthly_limit_krw = 1000000, max_inflight = 1000, scope_max_inflight = 100 where singleton;
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(6, 'req-h13-000000000001', repeat('c1', 32)) is not null)::text$$, 'true', 'H13 6원 예약(재시도 2회분)');
select test.expect_eq($$select api.ai_budget_uncertain(test.hid('req-h13-000000000001'), 3)::text$$, 'true', 'H13b 시간 초과 1회 전송 → 3원으로 불확실 정산');
select test.expect_eq($$select (api.ai_budget_uncertain(test.hid('req-h13-000000000001'), 3) or api.ai_budget_uncertain(test.hid('req-h13-000000000001')) or api.ai_budget_confirm(test.hid('req-h13-000000000001'), 1))::text$$, 'false', 'H13c 다시 닫기 불가(이중 정산 없음)');
select test.expect_eq($$select (api.ai_budget_hold(6, 'req-h13-000000000002', repeat('c1', 32)) is not null and api.ai_budget_uncertain(test.hid('req-h13-000000000002'), 99))::text$$, 'true', 'H13d 예약 초과 금액 요청');
select test.expect_eq($$select (api.ai_budget_hold(6, 'req-h13-000000000003', repeat('c1', 32)) is not null and api.ai_budget_uncertain(test.hid('req-h13-000000000003'), 0))::text$$, 'true', 'H13e 0원 요청');
select test.expect_error($$select api.ai_budget_uncertain(1, null)$$, '22023', 'H13f 금액 null 거부');
reset role;
select test.expect_eq($$select string_agg(x.kind || ':' || x.actual_cost_krw, ',' order by u.request_id) from core.ai_usage_ledger u join core.ai_usage_closures x on x.reservation_id = u.id where u.request_id like 'req-h13-%'$$, 'uncertain:3,uncertain:6,uncertain:1', 'H13g 금액: 3원 / 예약 초과 → 예약(6원) / 0 → 1원');
select test.expect_eq($$select split_part(test.spent_now(repeat('c1', 32)), '|', 4)$$, '10', 'H13h 사용자 사용액 = 3 + 6 + 1(예약 전액 18원 아님)');
set role app_public;
select test.expect_error($$select api.ai_budget_uncertain(1, 1)$$, '42501', 'H13i app_public 실행 불가');
reset role;
update core.ai_budget_config set paused = false, monthly_limit_krw = 0, daily_limit_krw = 0, scope_daily_limit_krw = 0, scope_monthly_limit_krw = 0, max_inflight = 0, scope_max_inflight = 1 where singleton;
