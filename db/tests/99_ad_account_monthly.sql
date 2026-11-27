-- 0036 계정 누적 3만원 평생 → 한국 시간 월별(PM 11/25 ① 승인). 가상 데이터만, 실제 광고 API·광고비 없음.
\set ON_ERROR_STOP 1
\ir reset_ad_account.sql
set session_replication_role = replica;
delete from core.ad_performance;
set session_replication_role = origin;
update core.ad_month_config set monthly_limit_krw = 1000000, margin_pct = 10;
set role app_ad_monitor;
select api.ad_monitor_record(true, '{}'::jsonb);
reset role;
set role app_staff;
select test.expect_ok(test.adapprove('owner', 'camp-am-a', 10000, 30000, 72, '월별 전환 시험 A'), 'AT0 승인 A');
select test.expect_ok(test.adapprove('owner', 'camp-am-b', 10000, 30000, 72, '월별 전환 시험 B'), 'AT0b 승인 B');
select test.expect_ok(test.adapprove('owner', 'camp-am-c', 10000, 30000, 72, '월별 전환 시험 C(다른 날 기록용)'), 'AT0c 승인 C');
reset role;
select test.expect_eq($$select core.ad_month_effective_limit()::text$$, '30000', 'AT1 월 판정 한도 = least(월 예산 100만 × 90%, 계정 월 3만) = 3만');
-- 지난달 3만원 사용(원장 직접 기록): 예전(평생 누적)이면 이번 달 1원도 막혔다
insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
select 'camp-am-c', (select id from core.ad_budget_approvals where campaign_key = 'camp-am-c' and state = 'active'), date_trunc('month', now() at time zone 'Asia/Seoul')::date - d, 10000, k, '00000000-0000-4000-8000-000000000001'
from (values (1, 'req-am-prev-000001'), (2, 'req-am-prev-000002'), (3, 'req-am-prev-000003')) v(d, k);
select test.expect_eq($$select core.ad_account_total()::text || '/' || core.ad_account_month((date_trunc('month', now() at time zone 'Asia/Seoul') - interval '1 day')::date)::text$$, '0/30000', 'AT2 지난달 3만원은 지난달 합계에만 남고 이번 달 누적은 0');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-am-a', 5000, 'req-am-a-000000001'$$, 'decision'), 'ALLOW', 'AT3 다음 달(이번 달)에는 다시 집행 가능 — 평생 누적 3만 문제 해결');
reset role;
-- 이번 달(오늘 이후 날짜) 합계가 3만에 닿으면 차단: 일·3일·월 한도는 그대로
insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
select 'camp-am-c', (select id from core.ad_budget_approvals where campaign_key = 'camp-am-c' and state = 'active'), (now() at time zone 'Asia/Seoul')::date + d, amt, k, '00000000-0000-4000-8000-000000000001'
from (values (40, 10000, 'req-am-next-000001'), (41, 10000, 'req-am-next-000002'), (42, 4000, 'req-am-next-000003')) v(d, amt, k);
select test.expect_eq($$select core.ad_account_total()::text$$, '29000', 'AT4 이번 달 이후 예약(오늘 5천 + 뒤 날짜 2.4만)은 누적에 포함(월말 이월 보수 판정)');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-am-a', 5001, 'req-am-a-000000002'$$, 'reason'), 'DAILY_CAP_EXCEEDED', 'AT5 캠페인 일 1만 유지(5천 + 5,001)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-am-b', 1001, 'req-am-b-000000001'$$, 'reason'), 'ACCOUNT_TOTAL_CAP_EXCEEDED', 'AT6 계정 이번 달 누적 2.9만 + 1,001 > 3만 차단(일 한도 안)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-am-b', 1000, 'req-am-b-000000002'$$, 'decision'), 'ALLOW', 'AT6b 정확히 3만은 허용');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-am-b', 1, 'req-am-b-000000003'$$, 'reason'), 'ACCOUNT_TOTAL_CAP_EXCEEDED', 'AT6c 3만 도달 뒤 1원 차단');
reset role;
-- 월 경계(가상 미래 날짜, 판정 함수 직접): 달마다 3만
\ir reset_ad_account.sql
insert into core.ad_exposure (request_key, serve_date, campaign_key, approval_id, max_krw)
select 'req-am-m-000000001', d, 'camp-am-a', (select id from core.ad_budget_approvals where campaign_key = 'camp-am-a' and state = 'active'), 10000
  from generate_series(date '2031-01-29', date '2031-01-31', interval '1 day') d;
select test.expect_eq($$select coalesce(core.ad_month_check('2031-02-01', '2031-02-03', 10000), 'OK')$$, 'OK', 'AT7 1월 3만 사용 뒤 2월 1~3일 1만씩(2월 3만) 허용 — 새 달은 0부터');
select test.expect_eq($$select core.ad_month_check('2031-01-31', '2031-02-01', 1)$$, 'MONTHLY_CAP_EXCEEDED', 'AT7b 1월 31일이 걸친 기간은 1월 3만 초과로 차단');
select test.expect_eq($$select core.ad_month_check('2031-02-01', '2031-02-04', 7501)$$, 'MONTHLY_CAP_EXCEEDED', 'AT7c 2월 4일 × 7,501 > 3만 차단');
update core.ad_month_config set monthly_limit_krw = 0;
select test.expect_eq($$select core.ad_month_effective_limit()::text || '/' || core.ad_month_check('2031-02-01', '2031-02-01', 1)$$, '0/MONTHLY_BUDGET_UNSET', 'AT8 월 예산 0원이면 계정 3만과 무관하게 차단(기본값 유지)');
update core.ad_month_config set monthly_limit_krw = 10000, margin_pct = 20;
select test.expect_eq($$select core.ad_month_effective_limit()::text$$, '8000', 'AT8b 월 예산이 3만보다 작으면 월 예산 판정 한도(8천)가 적용');
\ir reset_ad_account.sql
update core.ad_month_config set monthly_limit_krw = 1000000, margin_pct = 10;
