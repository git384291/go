-- AI 비용 하드 한도 보강(0025, PM 11/24 A·B·C): 초과 정산 기록·잠금, 멱등성 키, 일일 한도(Asia/Seoul). 가상 데이터만, 실제 AI 호출 없음.
\set ON_ERROR_STOP 1
reset role;
create function test.hk(p_cost int, p_key text, p_hash text) returns text language sql as $$
  select coalesce(h.hold_id::text, '-') || ':' || h.outcome from api.ai_budget_hold_keyed(p_cost, p_key, p_hash) h $$;
create function test.hkid(p_key text) returns bigint language sql security definer set search_path = pg_catalog as $$
  select u.id from core.ai_usage_ledger u where u.request_key = p_key $$;
create function test.dused() returns int language sql security definer set search_path = pg_catalog as $$
  select coalesce(sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end), 0)::int
  from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id where u.day = (now() at time zone 'Asia/Seoul')::date $$;
create function test.mused() returns int language sql security definer set search_path = pg_catalog as $$ select test.used()::int $$;
create function test.limits(p_month int, p_day int) returns void language sql security definer set search_path = pg_catalog as $$
  update core.ai_budget_config set monthly_limit_krw = p_month, daily_limit_krw = p_day where singleton $$;
create function test.k(p int) returns text language sql immutable as $$ select 'hc-key-' || lpad(p::text, 12, '0') $$;
create function test.h(p int) returns text language sql immutable as $$ select encode(sha256(convert_to('hc-' || p, 'UTF8')), 'hex') $$;
grant execute on function test.hk(int, text, text), test.hkid(text), test.k(int), test.h(int) to app_ai;

-- 앞 시험(U14 범위 밖 확정)이 남긴 미확인 기록 → 새 예약 잠금
select test.limits(test.mused() + 100000, null);
set role app_ai;
select test.expect_eq($$select test.hk(10, null, null)$$, '-:overage_lock', 'H0 해제 안 된 미확인 정산이 있으면 새 예약 잠금(Fail-Closed)');
select test.expect_eq($$select (api.ai_budget_hold(10) is null)::text$$, 'true', 'H0b 기존 예약 함수도 같은 잠금 적용');
reset role;
set role app_staff;
select test.expect_eq('select open_overages::text from (' || test.adcall0('owner', 'ai_budget_guard_get') || ') x', '1', 'H0d 조회: 해제 안 된 초과 1건');
select test.expect_error(test.adcall('reviewer', 'ai_budget_overage_resolve', $$'검토자 해제'$$), '42501', 'H1 검토자 해제 불가');
select test.expect_error(test.adcall('counselor', 'ai_budget_overage_resolve', $$'상담원 해제'$$), '42501', 'H1b 상담원 해제 불가');
select test.expect_error(test.adcall('owner', 'ai_budget_overage_resolve', $$' '$$), '22023', 'H1c 사유 필수');
select test.expect_ok(test.adcall('owner', 'ai_budget_overage_resolve', $$'시험: 앞 단계 미확인 정산 확인'$$), 'H1d 대표 해제');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ai.overage_resolve'$$, '1', 'H1e 해제 감사 기록');
select test.expect_error($$update core.ai_usage_overages set actual_krw = 0$$, '42501', 'H1f 초과 기록 수정 불가(추가 전용)');
select test.expect_error($$delete from core.ai_overage_resolutions$$, '42501', 'H1g 해제 기록 삭제 불가(추가 전용)');

-- A. 예약 금액 초과 정산
select test.limits(test.mused() + 1000, null);
set role app_ai;
select test.expect_eq($$select split_part(test.hk(10, test.k(1), test.h(1)), ':', 2)$$, 'reserved', 'A1 10원 예약');
select test.expect_eq($$select api.ai_budget_confirm(test.hkid(test.k(1)), 900)::text$$, 'true', 'A2 예약 10원을 900원으로 확정 → 실제 금액으로 정산');
reset role;
select test.expect_eq($$select reserved_krw || '>' || actual_krw from core.ai_usage_overages o where o.reservation_id = test.hkid(test.k(1))$$, '10>900', 'A3 초과 내역 기록(예약 10 → 실제 900)');
select test.expect_eq($$select (select actual_cost_krw from core.ai_usage_closures where reservation_id = test.hkid(test.k(1)))::text$$, '900', 'A3b 사용액에 실제 900원 반영(줄여 세지 않음)');
set role app_ai;
select test.expect_eq($$select test.hk(1, test.k(2), test.h(2))$$, '-:overage_lock', 'A4 초과 뒤 새 AI 예약 차단');
select test.expect_eq($$select api.ai_budget_confirm(test.hkid(test.k(1)), 5)::text$$, 'false', 'A4b 같은 예약 재정산 불가');
reset role;
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ai_budget_overage_resolve', $$'시험: 초과 확인'$$), 'A5 대표 해제');
reset role;
-- 해제해도 사용액은 그대로라 한도 판정은 실제 금액 기준: 남은 예산 = 1000 - 10(?) 아님, 1000 - 900 = 100
set role app_ai;
select test.expect_eq($$select split_part(test.hk(101, test.k(3), test.h(3)), ':', 2)$$, 'monthly_limit', 'A6 해제 후에도 실제 900원 기준으로 한도 판정(101원 거부)');
select test.expect_eq($$select split_part(test.hk(100, test.k(4), test.h(4)), ':', 2)$$, 'reserved', 'A6b 남은 100원은 예약 가능');
-- 사용량 미확인(null)·범위 밖 → 정산 안 함(예약 전액으로 셈) + 잠금
select test.expect_eq($$select api.ai_budget_confirm(test.hkid(test.k(4)), null)::text$$, 'false', 'A7 사용량 미확인(null) 확정 거부');
reset role;
select test.expect_eq($$select coalesce(actual_krw::text, 'null') from core.ai_usage_overages where reservation_id = test.hkid(test.k(4))$$, 'null', 'A7b 미확인 기록(실제 금액 null)');
select test.expect_eq($$select count(*)::text from core.ai_usage_closures where reservation_id = test.hkid(test.k(4))$$, '0', 'A7c 미정산 유지 = 예약 100원 전액으로 셈');
set role app_ai;
select test.expect_eq($$select test.hk(1, test.k(5), test.h(5))$$, '-:overage_lock', 'A7d 미확인 뒤 새 예약 차단');
reset role;
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ai_budget_overage_resolve', $$'시험: 미확인 확인'$$), 'A8 대표 해제');
reset role;
select test.limits(test.mused() + 1000, null);
set role app_ai;
select test.expect_eq($$select split_part(test.hk(20, test.k(6), test.h(6)), ':', 2)$$, 'reserved', 'A9 20원 예약');
select test.expect_eq($$select api.ai_budget_confirm(test.hkid(test.k(6)), 5000)::text$$, 'false', 'A9b 범위 밖(5,000원) 확정 거부');
select test.expect_eq($$select test.hk(1, test.k(7), test.h(7))$$, '-:overage_lock', 'A9c 범위 밖 확정도 잠금');
reset role;
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ai_budget_overage_resolve', $$'시험: 범위 밖 확인'$$), 'A9d 대표 해제');
reset role;
set role app_ai;
select test.expect_eq($$select split_part(test.hk(20, test.k(8), test.h(8)), ':', 2)$$, 'reserved', 'A10 정상 예약');
select test.expect_eq($$select api.ai_budget_confirm(test.hkid(test.k(8)), 20)::text || api.ai_budget_release(test.hkid(test.k(8)))::text$$, 'truefalse', 'A10b 예약 이하 확정은 잠금 없음');
select test.expect_eq($$select split_part(test.hk(1, test.k(9), test.h(9)), ':', 2)$$, 'reserved', 'A10c 정상 확정 뒤 다음 예약 가능');
reset role;
select test.expect_eq($$select count(*)::text from core.ai_usage_overages o where not exists (select 1 from core.ai_overage_resolutions r where r.overage_id = o.id)$$, '0', 'A10d 열린 초과 0건');

-- B. 멱등성 키
set role app_ai;
select test.expect_eq($$select split_part(test.hk(5, test.k(20), test.h(20)), ':', 2) || ',' || split_part(test.hk(5, test.k(20), test.h(20)), ':', 2) || ',' || split_part(test.hk(5, test.k(20), test.h(20)), ':', 2)$$, 'reserved,replay,replay', 'B1 같은 키·같은 내용 재시도 → 새 예약 없음(replay)');
select test.expect_eq($$select test.hk(5, test.k(20), test.h(21))$$, '-:conflict', 'B2 같은 키·다른 내용 → 충돌');
select test.expect_eq($$select string_agg(split_part(test.hk(v.c, v.k, v.h), ':', 2), ',') from (values (5, 'short', test.h(1)), (5, test.k(22), 'zz'), (5, test.k(22), null), (5, null, test.h(1)), (0, test.k(22), test.h(22)), (1001, test.k(22), test.h(22))) v(c, k, h)$$, 'invalid,invalid,invalid,invalid,invalid,invalid', 'B3 키·지문 형식, 키만/지문만, 비용 범위 밖 → invalid');
select test.expect_eq($$select split_part(test.hk(5, test.k(22), test.h(22)), ':', 2)$$, 'reserved', 'B3b 거부된 키는 소비되지 않음(정상 요청은 예약)');
select test.expect_eq($$select (api.ai_budget_hold(1) is not null)::text$$, 'true', 'B4 키 없는 기존 예약 함수 그대로 동작');
reset role;
select test.expect_eq($$select count(*)::text from core.ai_usage_ledger where request_key = test.k(20)$$, '1', 'B5 같은 키 원장 1건');
select test.expect_error($$insert into core.ai_usage_ledger (month, cost_krw, request_key, request_hash) values ('2026-11', 1, test.k(20), test.h(20))$$, '23505', 'B6 DB 고유 제약이 같은 키 두 번째 행을 거부');

-- C. 일일 한도(Asia/Seoul)
select test.limits(test.mused() + 100000, null);
set role app_staff;
select test.expect_eq('select (g.daily_limit_krw = l.monthly_limit_krw)::text from (' || test.adcall0('owner', 'ai_budget_guard_get') || ') g, (' || test.adcall0('owner', 'ai_budget_limit_get') || ') l', 'true', 'C0 일 한도 미설정 = 월 한도와 같음(기존 동작 유지)');
select test.expect_error(test.adcall('reviewer', 'ai_budget_daily_limit_set', $$50, '검토자'$$), '42501', 'C1 검토자 일 한도 설정 불가');
select test.expect_error(test.adcall('editor', 'ai_budget_daily_limit_set', $$50, '편집자'$$), '42501', 'C1b 편집자 설정 불가');
select test.expect_error(test.adcall('counselor', 'ai_budget_daily_limit_set', $$50, '상담원'$$), '42501', 'C1c 상담원 설정 불가');
select test.expect_error(test.adcall('owner', 'ai_budget_daily_limit_set', $$-1, '음수'$$), '22023', 'C1d 음수 거부');
select test.expect_error(test.adcall('owner', 'ai_budget_daily_limit_set', $$100001, '상한 초과'$$), '22023', 'C1e 상한 초과 거부');
select test.expect_error(test.adcall('owner', 'ai_budget_daily_limit_set', $$50, ''$$), '22023', 'C1f 사유 필수');
reset role;
select test.expect_ok(format('select api.ai_budget_daily_limit_set(%L, %L, %L, %s, %L)', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'), test.dused() + 50, '시험 일 한도'), 'C2 대표 일 한도 설정(오늘 사용액 + 50원)');
select test.expect_eq($$select (detail ? 'old_limit_krw' and detail ? 'new_limit_krw')::text from core.audit_logs where action = 'ai.daily_limit_set' order by id desc limit 1$$, 'true', 'C2b 일 한도 변경 감사 기록(전후 값)');
set role app_ai;
select test.expect_eq($$select string_agg(split_part(test.hk(20, test.k(30 + g), test.h(30 + g)), ':', 2), ',') from generate_series(1, 3) g$$, 'reserved,reserved,daily_limit', 'C3 일 한도 초과 차단(월 한도는 남아 있음)');
reset role;
select test.limits(test.mused() + 10, test.dused() + 1000);
set role app_ai;
select test.expect_eq($$select split_part(test.hk(20, test.k(40), test.h(40)), ':', 2)$$, 'monthly_limit', 'C4 월 한도가 먼저 차면 월 한도로 차단(동시 적용)');
reset role;
-- 날짜 경계: 어제(서울) 원장은 오늘 일 사용액에 안 들어간다. 지난달 원장은 이번 달에 안 들어간다
select test.limits(test.mused() + 100000, test.dused() + 30);
insert into core.ai_usage_ledger (month, day, cost_krw) values (to_char(((now() at time zone 'Asia/Seoul') - interval '1 day'), 'YYYY-MM'), ((now() at time zone 'Asia/Seoul') - interval '1 day')::date, 1000);
create temp table t_m as select test.mused() as m;
insert into core.ai_usage_ledger (month, day, cost_krw) values (to_char(((now() at time zone 'Asia/Seoul') - interval '1 month'), 'YYYY-MM'), ((now() at time zone 'Asia/Seoul') - interval '1 month')::date, 1000);
select test.expect_eq($$select (test.mused() - (select m from t_m))::text$$, '0', 'C5 지난달 1,000원은 이번 달 사용액에 안 들어감');
set role app_ai;
select test.expect_eq($$select split_part(test.hk(30, test.k(41), test.h(41)), ':', 2)$$, 'reserved', 'C5b 어제 1,000원이 있어도 오늘 일 한도(30원) 안 예약 가능');
reset role;
-- 서버·세션 시간대와 무관하게 서울 날짜로 기록
set timezone = 'America/Los_Angeles';
select test.limits(test.mused() + 100000, null);
set role app_ai;
select test.expect_eq($$select split_part(test.hk(1, test.k(42), test.h(42)), ':', 2)$$, 'reserved', 'C6 다른 시간대 세션 예약');
reset role;
select test.expect_eq($$select (day = (now() at time zone 'Asia/Seoul')::date and month = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'))::text from core.ai_usage_ledger where id = test.hkid(test.k(42))$$, 'true', 'C6b 세션 시간대가 달라도 원장 날짜·월은 서울 기준');
reset timezone;
select test.expect_eq($$select count(*)::text from core.ai_usage_ledger where day is null$$, '0', 'C7 기존 원장 날짜 채움(null 0건)');

-- 권한
set role app_public;
select test.expect_error($$select * from api.ai_budget_hold_keyed(1, null, null)$$, '42501', 'P1 app_public은 멱등 예약 실행 불가');
reset role;
set role app_staff;
select test.expect_error($$select * from api.ai_budget_hold_keyed(1, null, null)$$, '42501', 'P1b app_staff도 실행 불가');
reset role;
set role app_ai;
select test.expect_error($$select api.ai_budget_daily_limit_set(gen_random_uuid(), gen_random_uuid(), 'x', 100000, '우회')$$, '42501', 'P2 app_ai는 일 한도 변경 불가');
select test.expect_error($$select api.ai_budget_overage_resolve(gen_random_uuid(), gen_random_uuid(), 'x', '우회')$$, '42501', 'P2b app_ai는 잠금 해제 불가');
select test.expect_error($$select * from core.ai_usage_overages$$, '42501', 'P3 app_ai는 초과 기록 직접 조회 불가');
select test.expect_error($$update core.ai_budget_config set daily_limit_krw = 100000$$, '42501', 'P3b app_ai는 설정표 직접 수정 불가');
reset role;
set role app_staff;
select test.expect_error($$select api.ai_budget_daily_limit_set('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'forged-token', 100000, '토큰 위조')$$, '42501', 'P4 위조 토큰으로 대표 권한 우회 불가');
reset role;

-- 뒤 시험(통합 시험)을 위해 원래 상태로: 월 한도 0원, 일 한도 미설정, 열린 초과 0건
select test.limits(0, null);
select test.expect_eq($$select count(*)::text from core.ai_usage_overages o where not exists (select 1 from core.ai_overage_resolutions r where r.overage_id = o.id)$$, '0', 'Z1 정리: 열린 초과 0건');
