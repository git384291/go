-- 광고 성과 수집·분석 + AI 사용료 집계(0011): 권한, 멱등, 초과 표시, 추가 전용, 예약 한도. 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1
\ir reset_ad_account.sql   -- 0020 계정 합산 한도: 앞 파일(70)의 당일 원장 격리
grant usage on schema test to app_ai;
grant execute on all functions in schema test to app_ai;

create function test.perf(p_who text, p_campaign text, p_offset int, p_imp int, p_clk int, p_cost int, p_source text default 'mock') returns text language sql security definer set search_path = test, pg_catalog as $$
  select test.adcall(p_who, 'ad_performance_record', format('%L, ((now() at time zone ''Asia/Seoul'')::date - %s), %s, %s, %s, %L', p_campaign, p_offset, p_imp, p_clk, p_cost, p_source)) $$;
create function test.perfres(p_who text, p_campaign text, p_offset int, p_imp int, p_clk int, p_cost int) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare r jsonb;
begin
  execute test.perf(p_who, p_campaign, p_offset, p_imp, p_clk, p_cost) into r;
  return (r->>'recorded') || ':' || coalesce(r->>'over_ledger', '');
end $$;
create function test.funnel(p_who text) returns text language plpgsql security definer set search_path = test, pg_catalog as $body$
declare r text; q text;
begin
  q := replace(test.adcall(p_who, 'ad_funnel', '(now() at time zone ''Asia/Seoul'')::date - 7, (now() at time zone ''Asia/Seoul'')::date'), 'select api.', 'select * from api.');
  execute 'select string_agg(campaign_key || '':'' || impressions || ''/'' || clicks || ''/'' || cost_krw || ''/'' || ledger_krw || ''/'' || leads || ''/'' || overspend_days, '','' order by campaign_key) from (' || q || ') f where campaign_key = ''camp-p''' into r;
  return coalesce(r, '');
end $body$;

-- 사전: camp-p 승인 + 오늘 500원 지출 허용
set role app_staff;
select test.expect_ok(test.adapprove('owner', 'camp-p', 5000, 20000), 'P0 승인');
select test.expect_eq($$select test.addecide('owner', 'camp-p', 500, 'req-p-0000000000001')$$, 'ALLOW:', 'P0b 지출 500원 허용');
-- P1 권한: owner만 기록, 조회는 owner·reviewer
select test.expect_error(test.perf('editor', 'camp-p', 0, 100, 10, 100), '42501', 'P1 policy_editor 성과 기록 불가');
select test.expect_error(test.perf('reviewer', 'camp-p', 0, 100, 10, 100), '42501', 'P1b 검토자 성과 기록 불가');
select test.expect_error(test.perf('counselor', 'camp-p', 0, 100, 10, 100), '42501', 'P1c 상담원 성과 기록 불가');
select test.expect_eq($$select test.perfres('owner', 'camp-p', 0, 1000, 40, 500)$$, 'true:false', 'P2 승인 원장 안의 광고비는 정상 기록');
select test.expect_eq($$select test.perfres('owner', 'camp-p', 0, 1000, 40, 500)$$, 'false:', 'P3 같은 날 같은 출처 재수집은 중복 기록 없음(멱등)');
select test.expect_eq($$select test.perfres('owner', 'camp-p', 1, 800, 20, 100)$$, 'true:true', 'P4 원장보다 큰 보고 광고비는 over_ledger로 표시');
-- P5 입력 검증
select test.expect_error(test.perf('owner', 'camp-p', 2, 10, 11, 0), '22023', 'P5 클릭이 노출보다 많으면 거부');
select test.expect_error(test.perf('owner', 'camp-p', -1, 10, 1, 0), '22023', 'P5b 미래 날짜 거부');
select test.expect_error(test.perf('owner', 'camp-p', 2, 10, 1, 0, 'other'), '22023', 'P5c 알 수 없는 출처 거부');
select test.expect_error(test.perf('owner', 'Bad Key', 2, 10, 1, 0), '22023', 'P5d 캠페인 키 형식 거부');
select test.expect_error(test.perf('owner', 'camp-p', 2, 10, 1, -5), '22023', 'P5e 음수 광고비 거부');
-- P6 분석(건수·합계만): 접수 0건
select test.expect_eq($$select test.funnel('owner')$$, 'camp-p:1800/60/600/500/0/1', 'P6 대표 분석: 노출·클릭·보고비·원장·접수·초과일수');
select test.expect_eq($$select test.funnel('reviewer')$$, 'camp-p:1800/60/600/500/0/1', 'P6b 검토자도 조회');
select test.expect_error(test.adcall('counselor', 'ad_funnel', $$current_date - 1, current_date$$), '42501', 'P6c 상담원 조회 불가');
select test.expect_error(test.adcall('owner', 'ad_funnel', $$current_date, current_date - 1$$), '22023', 'P6d 거꾸로 된 기간 거부');
select test.expect_error(test.adcall('owner', 'ad_funnel', $$current_date - 200, current_date$$), '22023', 'P6e 92일 넘는 기간 거부');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.performance_overspend'$$, '1', 'P7 초과 보고는 감사 기록');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.performance_collect'$$, '1', 'P7b 정상 수집 감사 기록');
-- P8 추가 전용
select test.expect_error($$update core.ad_performance set cost_krw = 0$$, '42501', 'P8 성과 수정 불가');
select test.expect_error($$delete from core.ad_performance$$, '42501', 'P8b 성과 삭제 불가');

-- AI 사용료 예약
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(3, gen_random_uuid()::text, repeat('a', 64)) is not null)::text$$, 'false', 'U1 기본 한도 0원이면 예약 거부(호출 금지)');
reset role;
select test.expect_eq($$select count(*)::text from core.ai_usage_ledger$$, '0', 'U1b 거부는 원장에 쓰지 않음');
update core.ai_budget_config set monthly_limit_krw = 5, daily_limit_krw = 1000000, scope_daily_limit_krw = 1000000, scope_monthly_limit_krw = 1000000, max_inflight = 1000 where singleton;  -- 0025: 일·사용자 한도는 넉넉히(월 한도만 시험)
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(3, gen_random_uuid()::text, repeat('a', 64)) is not null)::text$$, 'true', 'U2 한도 안 예약');
select test.expect_eq($$select (api.ai_budget_hold(2, gen_random_uuid()::text, repeat('a', 64)) is not null)::text$$, 'true', 'U2b 한도 딱 맞게 예약');
select test.expect_eq($$select (api.ai_budget_hold(1, gen_random_uuid()::text, repeat('a', 64)) is not null)::text$$, 'false', 'U3 한도 초과 거부');
select test.expect_eq($$select (api.ai_budget_hold(0, gen_random_uuid()::text, repeat('a', 64)) is not null)::text || (api.ai_budget_hold(1001, gen_random_uuid()::text, repeat('a', 64)) is not null)::text || (api.ai_budget_hold(null, gen_random_uuid()::text, repeat('a', 64)) is not null)::text || (api.ai_budget_hold(-1, gen_random_uuid()::text, repeat('a', 64)) is not null)::text$$, 'falsefalsefalsefalse', 'U4 범위 밖 비용은 거부');
select test.expect_error($$select * from core.ai_usage_ledger$$, '42501', 'U5 전용 역할도 원장 직접 조회 불가');
select test.expect_error($$select * from core.ai_budget_config$$, '42501', 'U5b 한도 설정 직접 조회 불가');
reset role;
select test.expect_eq($$select sum(cost_krw)::text from core.ai_usage_ledger$$, '5', 'U6 원장 합계 = 예약된 비용만');
select test.expect_error($$update core.ai_usage_ledger set cost_krw = 1$$, '42501', 'U7 사용 원장 수정 불가');
select test.expect_error($$delete from core.ai_usage_ledger$$, '42501', 'U7b 사용 원장 삭제 불가');
select test.expect_error($$delete from core.ai_budget_config$$, '42501', 'U7c 한도 설정 삭제 불가');
-- U8 다른 앱 역할은 실행 불가
set role app_public;
select test.expect_error($$select (api.ai_budget_hold(1, gen_random_uuid()::text, repeat('a', 64)) is not null)$$, '42501', 'U8 app_public은 AI 사용료 예약 실행 불가');
reset role;
set role app_staff;
select test.expect_error($$select (api.ai_budget_hold(1, gen_random_uuid()::text, repeat('a', 64)) is not null)$$, '42501', 'U8b app_staff도 실행 불가');
reset role;
update core.ai_budget_config set monthly_limit_krw = 0 where singleton;
