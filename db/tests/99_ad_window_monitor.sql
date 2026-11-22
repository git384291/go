-- 0021 (PM 11/22 P0): 집행 기간(최대 3개 날짜, 승인 만료 전 종료)·날짜별 최대 청구액 계정 합산·정기 감시 게이트. 가상 데이터만, 실제 광고 API 없음.
\set ON_ERROR_STOP 1
\ir reset_ad_account.sql
-- 종료일 경계(KST): least(오늘+2, 만료 시각이 속한 날짜−1)
select test.expect_eq($$select core.ad_window_end('2026-11-22', '2026-11-25 13:00+09')::text$$, '2026-11-24', 'WM1 72시간 승인(11/22 13:00~11/25 13:00, 4개 날짜)도 집행은 11/22~11/24 3개 날짜');
select test.expect_eq($$select core.ad_window_end('2026-11-22', '2026-11-25 00:00+09')::text$$, '2026-11-24', 'WM1b 만료가 정확히 0시면 그 전날까지(종료일 다음 날 0시 = 만료)');
select test.expect_eq($$select core.ad_window_end('2026-11-22', '2026-11-24 23:59:59+09')::text$$, '2026-11-23', 'WM1c 만료 23:59:59면 하루 앞당김(매체 종료 23:59:59 > 만료 불가)');
select test.expect_eq($$select core.ad_window_end('2026-11-22', '2026-11-23 00:00+09')::text$$, '2026-11-22', 'WM1d 다음 날 0시 만료 → 오늘 하루');
select test.expect_eq($$select (core.ad_window_end('2026-11-22', '2026-11-22 23:00+09') < date '2026-11-22')::text$$, 'true', 'WM1e 오늘 안에 만료 → 종료일이 오늘보다 이름(APPROVAL_TOO_SHORT)');
select test.expect_eq($$select core.ad_window_end('2026-11-22', '2026-11-22 15:30+00')::text$$, '2026-11-22', 'WM1f UTC 15:30(=KST 11/23 00:30) 만료 → 11/22 하루(시간대 KST 기준)');

set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-wm-a', 10000, 30000, now() + interval '72 hours', '집행 기간 검증 A'$$), 'WM2 A 승인 72시간(일 1만·누적 3만)');
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-wm-b', 10000, 30000, now() + interval '72 hours', '집행 기간 검증 B'$$), 'WM2b B 승인 72시간');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-a', 10000, 'req-wm-a-00000001'$$, 'reason'), 'MONITOR_STALE', 'WM3 정기 감시 기록 없음 → 새 집행 차단');
reset role;
set role app_ad_monitor;
select api.ad_monitor_record(false, '{"unknown": 1}'::jsonb);
reset role;
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-a', 10000, 'req-wm-a-00000001'$$, 'reason'), 'MONITOR_NOT_OK', 'WM3b 마지막 감시가 불명·실패 → 새 집행 차단');
reset role;
insert into core.ad_monitor_runs (ran_at, ok, detail) values (now() - interval '3 hours', true, '{}');
set role app_ad_monitor;
select api.ad_monitor_record(true, '{"checked": 0}'::jsonb);
reset role;
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-a', 10000, 'req-wm-a-00000001'$$, 'decision'), 'ALLOW', 'WM4 감시 정상(2시간 안) → 72시간 승인에 일 1만 3일(최대 3만) 허용');
reset role;
select test.expect_eq($$select count(*)::text || '/' || sum(max_krw)::text || '/' || (max(serve_date) - min(serve_date))::text from core.ad_exposure where request_key = 'req-wm-a-00000001'$$, '3/30000/2', 'WM4b 날짜별 최대 청구액 3개 날짜 × 1만 기록(4번째 날짜 없음)');
select test.expect_eq($$select (max(serve_date) = (now() at time zone 'Asia/Seoul')::date + 2)::text from core.ad_exposure where request_key = 'req-wm-a-00000001'$$, 'true', 'WM4c 종료일 = 오늘+2(4일째 지출 없음)');
select test.expect_eq($$select ((max(serve_date) + 1)::timestamp at time zone 'Asia/Seoul' <= (select valid_until from core.ad_budget_approvals where campaign_key = 'camp-wm-a' and state = 'active'))::text from core.ad_exposure where request_key = 'req-wm-a-00000001'$$, 'true', 'WM4d 종료일 다음 날 0시(KST) ≤ 승인 만료');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-b', 2, 'req-wm-b-00000001'$$, 'reason'), 'ACCOUNT_TOTAL_CAP_EXCEEDED', 'WM5 A가 3일 최대 3만을 잡아 B는 2원도 차단(누적 3만 넘길 가능성)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-wm-b', 1, 'req-wm-b-00000002'$$, 'reason'), 'ACCOUNT_DAILY_CAP_EXCEEDED', 'WM5b 예전 판정 함수도 집행 기간 최대액을 계정 합계에 포함(우회 불가)');
select test.expect_error(test.adcall('owner', 'ad_spend_request_window', $$'camp-wm-b', 1, 'req-wm-b-00000003'$$), '22023', 'WM5c 1원은 매체 일예산(÷2)이 0이라 거부');
reset role;

-- 날짜별 합산: 오늘만 쓰는 1일 승인 2건 → 같은 날 계정 1만 초과 차단
\ir reset_ad_account.sql
set role app_ad_monitor;
select api.ad_monitor_record(true, '{}'::jsonb);
reset role;
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-wm-c', 6000, 6000, (date_trunc('day', now() at time zone 'Asia/Seoul') + interval '1 day 1 hour') at time zone 'Asia/Seoul', '하루 승인 C'$$), 'WM6 C 승인(내일 01:00 만료 → 오늘 하루)');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-c', 6000, 'req-wm-c-00000001'$$, 'days'), '1', 'WM6b 만료가 내일 새벽이면 집행 1일');
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-wm-d', 6000, 6000, (date_trunc('day', now() at time zone 'Asia/Seoul') + interval '1 day 1 hour') at time zone 'Asia/Seoul', '하루 승인 D'$$), 'WM6c D 승인');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-d', 6000, 'req-wm-d-00000001'$$, 'reason'), 'ACCOUNT_DAILY_CAP_EXCEEDED', 'WM6d 같은 날 C 6천 + D 6천 > 계정 1만 차단');
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-wm-e', 6000, 6000, greatest(now() + interval '1 second', least(now() + interval '1 hour', (date_trunc('day', now() at time zone 'Asia/Seoul') + interval '1 day' - interval '1 second') at time zone 'Asia/Seoul')), '오늘 만료 E'$$), 'WM7 E 승인(오늘 안 만료)');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-e', 1000, 'req-wm-e-00000001'$$, 'reason'), 'APPROVAL_TOO_SHORT', 'WM7b 오늘 안에 끝나는 승인은 매체 종료(23:59:59)보다 먼저 만료 → 집행 금지');
reset role;

-- 정기 감시 중지: 승인 철회, 매체 중지 실패면 경고(계정 전체 차단)
set role app_ad_monitor;
select api.ad_monitor_stop('camp-wm-c', 'WINDOW_ENDED', false);
reset role;
select test.expect_eq($$select count(*)::text from core.ad_alerts where campaign_key = 'camp-wm-c' and state = 'open'$$, '1', 'WM8 감시 역할의 중지 실패 → 경고 열림');
select test.expect_eq($$select state from core.ad_budget_approvals where campaign_key = 'camp-wm-c' order by created_at desc limit 1$$, 'revoked', 'WM8b 승인 철회');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-wm-d', 100, 'req-wm-d-00000002'$$, 'reason'), 'STOP_PENDING', 'WM8c 중지 실패 경고 → 계정 전체 새 집행 차단');
reset role;
-- 권한: 감시 역할은 감시 함수 3개만, 직원 역할은 감시 함수 불가
select test.expect_eq($$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('core', 'pii', 'security', 'api') and has_function_privilege('app_ad_monitor', p.oid, 'EXECUTE')$$, 'ad_monitor_record,ad_monitor_stop,ad_monitor_targets', 'WM9 app_ad_monitor 실행 가능 함수는 감시 3개뿐');
select test.expect_eq($$select has_function_privilege('app_staff', 'api.ad_monitor_stop(text,text,boolean)', 'EXECUTE')::text || has_function_privilege('app_public', 'api.ad_monitor_record(boolean,jsonb)', 'EXECUTE')::text$$, 'falsefalse', 'WM9b 직원·공개 역할은 감시 함수 실행 불가');
select test.expect_eq($$select count(*)::text from information_schema.role_table_grants where grantee = 'app_ad_monitor'$$, '0', 'WM9c 감시 역할 테이블 권한 0');
select test.expect_error($$update core.ad_exposure set max_krw = 1$$, '42501', 'WM10 집행 기간 기록 수정 불가');
select test.expect_error($$delete from core.ad_monitor_runs$$, '42501', 'WM10b 감시 기록 삭제 불가');
\ir reset_ad_account.sql
