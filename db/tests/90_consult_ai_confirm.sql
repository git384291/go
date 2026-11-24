-- 상담 시작 집계·전환 분석(0012)과 AI 비용 예약·확정·취소. 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1
grant usage on schema test to app_public;

create function test.fullfunnel(p_who text, p_camp text) returns text language plpgsql security definer set search_path = test, pg_catalog as $body$
declare r text; q text;
begin
  q := replace(test.adcall(p_who, 'ad_funnel_full', '(now() at time zone ''Asia/Seoul'')::date - 7, (now() at time zone ''Asia/Seoul'')::date'), 'select api.', 'select * from api.');
  execute 'select string_agg(campaign_key || '':'' || impressions || ''/'' || clicks || ''/'' || consults || ''/'' || leads, '','') from (' || q || format(') f where campaign_key = %L', p_camp) into r;
  return coalesce(r, '');
end $body$;

-- S1 상담 시작: 세션 키당 1건(멱등), 형식 밖 키 거부, 캠페인 형식 밖은 캠페인 없음으로 기록
set role app_public;
select test.expect_ok($$select api.consult_event_record('sess-aaaaaaaaaaaaaaaa1', 'camp-q')$$, 'S1 상담 시작 기록');
select test.expect_ok($$select api.consult_event_record('sess-aaaaaaaaaaaaaaaa1', 'camp-q')$$, 'S1b 같은 세션 재전송은 중복 없음');
select test.expect_ok($$select api.consult_event_record('sess-aaaaaaaaaaaaaaaa2', 'camp-q')$$, 'S1c 다른 세션');
select test.expect_ok($$select api.consult_event_record('sess-aaaaaaaaaaaaaaaa3', 'Bad Key!')$$, 'S1d 형식 밖 캠페인은 캠페인 없이 기록');
select test.expect_error($$select api.consult_event_record('short', 'camp-q')$$, '22023', 'S2 형식 밖 세션 키 거부');
select test.expect_error($$select api.consult_event_record(null, 'camp-q')$$, '22023', 'S2b 세션 키 없음 거부');
select test.expect_error($$select * from core.consult_events$$, '42501', 'S3 앱 역할은 상담 기록 직접 조회 불가');
reset role;
select test.expect_eq($$select count(*)::text from core.consult_events where session_key like 'sess-aaaaaaaaaaaaaaaa%'$$, '3', 'S4 3세션 = 3건');
select test.expect_eq($$select count(*)::text from core.consult_events where session_key = 'sess-aaaaaaaaaaaaaaaa3' and campaign_key is null$$, '1', 'S4b 형식 밖 캠페인은 null');
select test.expect_error($$update core.consult_events set campaign_key = null$$, '42501', 'S5 상담 기록 수정 불가');
select test.expect_error($$delete from core.consult_events$$, '42501', 'S5b 상담 기록 삭제 불가');
-- S6 분석: 상담 열(세션 수), 권한
set role app_staff;
select test.expect_eq($$select test.fullfunnel('owner', 'camp-q')$$, 'camp-q:0/0/2/0', 'S6 대표 분석: 상담 2건(접수 0)');
select test.expect_eq($$select test.fullfunnel('reviewer', 'camp-q')$$, 'camp-q:0/0/2/0', 'S6b 검토자 조회');
-- S6g 광고→상담→접수 한 줄: 같은 캠페인 키로 들어온 접수는 같은 행의 접수 열에 더해진다. 점이 든 키(화면은 버림)는 다른 캠페인으로 새지 않는다
reset role;
insert into core.leads (name_masked, phone_last4, interest, utm_source, utm_campaign, idempotency_key)
values ('김*', '0001', 'internet_tv', 'naver', 'camp-q', 'idem-funnel-0000000001'),
       ('이*', '0002', 'internet_tv', 'naver', 'camp.q', 'idem-funnel-0000000002');
set role app_staff;
select test.expect_eq($$select test.fullfunnel('owner', 'camp-q')$$, 'camp-q:0/0/2/1', 'S6g 같은 캠페인: 상담 2·접수 1이 한 행');
select test.expect_eq($$select test.fullfunnel('owner', 'camp.q')$$, 'camp.q:0/0/0/1', 'S6h 형식 밖 캠페인 키 접수는 별도 행(상담·광고와 섞이지 않음)');
reset role;
delete from core.leads where idempotency_key in ('idem-funnel-0000000001', 'idem-funnel-0000000002');
set role app_staff;
select test.expect_error(test.adcall('counselor', 'ad_funnel_full', $$current_date - 1, current_date$$), '42501', 'S6c 상담원 조회 불가');
select test.expect_error(test.adcall('editor', 'ad_funnel_full', $$current_date - 1, current_date$$), '42501', 'S6d 정책 편집자 조회 불가');
select test.expect_error(test.adcall('owner', 'ad_funnel_full', $$current_date, current_date - 1$$), '22023', 'S6e 거꾸로 된 기간 거부');
reset role;

-- 정산 시험: 월 한도 100원
update core.ai_budget_config set monthly_limit_krw = (select coalesce(sum(cost_krw), 0) from core.ai_usage_ledger where month = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM')) + 100, daily_limit_krw = 1000000, scope_daily_limit_krw = 1000000, scope_monthly_limit_krw = 1000000, max_inflight = 1000 where singleton;  -- 0028
create temp table t_base as select (select coalesce(sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end), 0) from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id) as used;
create function test.used() returns text language sql security definer set search_path = pg_catalog as $$
  select coalesce(sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end), 0)::text
  from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id where u.month = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM') $$;
create function test.lastid(p_cost int) returns bigint language sql security definer set search_path = pg_catalog as $$ select max(id) from core.ai_usage_ledger where cost_krw = p_cost $$;
grant execute on function test.lastid(int) to app_ai;
set role app_ai;
select test.expect_eq($$select (api.ai_budget_hold(60, gen_random_uuid()::text, repeat('a', 64)) is not null)::text$$, 'true', 'U9 예약 60원(한도 100원 안)');
select test.expect_eq($$select (api.ai_budget_hold(60, gen_random_uuid()::text, repeat('a', 64)) is null)::text$$, 'true', 'U9b 두 번째 60원은 한도 초과로 거부(null)');
select test.expect_eq($$select (api.ai_budget_hold(0, gen_random_uuid()::text, repeat('a', 64)) is null and api.ai_budget_hold(1001, gen_random_uuid()::text, repeat('a', 64)) is null and api.ai_budget_hold(null, gen_random_uuid()::text, repeat('a', 64)) is null)::text$$, 'true', 'U9c 범위 밖 비용은 null');
reset role;
select test.expect_eq($$select (select count(*) from core.ai_usage_ledger where cost_krw = 60 and id not in (select reservation_id from core.ai_usage_closures))::text$$, '1', 'U10 미정산 예약 1건 = 전액 계산');
-- 확정(실제 비용 20원) → 사용액이 줄어 다시 예약 가능
set role app_ai;
select test.expect_eq($$select api.ai_budget_confirm(test.lastid(60), 20)::text$$, 'true', 'U11 확정(실제 20원)');
select test.expect_eq($$select api.ai_budget_confirm(test.lastid(60), 5)::text$$, 'false', 'U11b 같은 예약 재정산 불가');
select test.expect_eq($$select api.ai_budget_release(test.lastid(60))::text$$, 'false', 'U11c 확정된 예약은 취소 불가');
select test.expect_eq($$select (api.ai_budget_hold(70, gen_random_uuid()::text, repeat('a', 64)) is not null)::text$$, 'true', 'U12 확정으로 줄어든 사용액 덕에 70원 예약 가능');
-- 취소 → 0원 처리
select test.expect_eq($$select api.ai_budget_release(test.lastid(70))::text$$, 'true', 'U13 취소');
select test.expect_eq($$select api.ai_budget_release(test.lastid(70))::text$$, 'false', 'U13b 같은 예약 재취소 불가');
select test.expect_eq($$select api.ai_budget_confirm(test.lastid(70), 10)::text$$, 'false', 'U13c 취소된 예약은 확정 불가');
select test.expect_eq($$select (api.ai_budget_confirm(999999999, 1) or api.ai_budget_release(999999999) or api.ai_budget_confirm(null, 1) or api.ai_budget_confirm(1, -1) or api.ai_budget_confirm(1, 1001))::text$$, 'false', 'U14 없는 예약·범위 밖 값은 false');
select test.expect_error($$select * from core.ai_usage_closures$$, '42501', 'U15 정산 기록 직접 조회 불가');
reset role;
-- 사용액 = 기준 + 확정 20 + 취소 0 (예약 70은 취소라 0) → 기준 + 20
select test.expect_eq($$select (test.used()::int - (select used from t_base))::text$$, '20', 'U16 사용액 = 확정 20원(취소 0원 제외)');
select test.expect_error($$update core.ai_usage_closures set actual_cost_krw = 0$$, '42501', 'U17 정산 수정 불가');
select test.expect_error($$delete from core.ai_usage_closures$$, '42501', 'U17b 정산 삭제 불가');
set role app_public;
select test.expect_error($$select api.ai_budget_confirm(1, 1)$$, '42501', 'U18 app_public은 정산 실행 불가');
reset role;
set role app_staff;
select test.expect_error($$select api.ai_budget_hold(1, gen_random_uuid()::text, repeat('a', 64))$$, '42501', 'U18b app_staff는 예약 실행 불가');
reset role;
update core.ai_budget_config set monthly_limit_krw = 0 where singleton;
