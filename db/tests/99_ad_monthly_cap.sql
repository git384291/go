-- 0034 광고 월 예산 하드 한도(PM 11/25 M1~M4·M6·M8·M11~M14 DB 부분). 가상 데이터만, 실제 Google Ads API·광고비 없음.
-- M5·M14 동시 요청(100건·여러 연결)은 scripts/db-test.sh가 병렬 psql로 시험한다.
\set ON_ERROR_STOP 1
\ir reset_ad_account.sql
create or replace function test.lx0(p_who text, p_fn text, p_key text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
begin
  return format('select (%s)::jsonb ->> %L', regexp_replace(test.adcall0(p_who, p_fn), '^select (\* from )?', ''), p_key);
end $$;
-- 월 사용액은 보고 비용(ad_performance)도 본다: 앞 시험이 남긴 가상 보고를 이 폐기 DB에서만 비운다
set session_replication_role = replica;
delete from core.ad_performance;
set session_replication_role = origin;
-- db-test.sh가 기존 광고 시험용으로 넉넉히 설정해 둔 값을 이 시험 동안 기본값(0원·20%)으로 되돌린다(폐기 DB, 슈퍼유저)
update core.ad_month_config set monthly_limit_krw = 0, margin_pct = 20;
set role app_ad_monitor;
select api.ad_monitor_record(true, '{}'::jsonb);
reset role;

set role app_staff;
select test.expect_ok(test.adapprove('owner', 'camp-mc-a', 10000, 30000, 72, '월 예산 시험 A'), 'MC0 A 승인');
select test.expect_ok(test.adapprove('owner', 'camp-mc-b', 10000, 30000, 72, '월 예산 시험 B'), 'MC0b B 승인');
-- M1 미설정(0원) = 차단
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-mc-a', 1000, 'req-mc-a-00000001'$$, 'reason'), 'MONTHLY_BUDGET_UNSET', 'M1 월 예산 미설정(0원) → 집행 판정 차단');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-a', 1000, 'req-mc-a-00000002'$$, 'reason'), 'MONTHLY_BUDGET_UNSET', 'M1b 예전 지출 판정 함수도 차단(우회 불가)');
reset role;
select test.expect_eq($$select count(*)::text || '/' || (select count(*) from core.ad_exposure)::text from core.ad_spend_ledger$$, '0/0', 'M1c 차단 시 원장·최대 청구액 기록 0건');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.spend_blocked' and reason = 'MONTHLY_BUDGET_UNSET'$$, '2', 'M1d 차단 판정 감사 기록');

-- M11 권한 없는 변경 차단 + 비정상 값 거부
set role app_staff;
select test.expect_error(test.adcall('editor', 'ad_monthly_budget_set', $$10000, 20, '권한 우회'$$), '42501', 'M11 정책 편집자는 월 예산 변경 불가');
select test.expect_error(test.adcall('reviewer', 'ad_monthly_budget_set', $$10000, 20, '권한 우회'$$), '42501', 'M11b 검토자도 변경 불가(조회만)');
select test.expect_error(test.adcall('counselor', 'ad_monthly_budget_set', $$10000, 20, '권한 우회'$$), '42501', 'M11c 상담원 변경 불가');
select test.expect_error(test.adcall('owner', 'ad_monthly_budget_set', $$-1, 20, '음수'$$), '22023', 'M11d 음수 거부');
select test.expect_error(test.adcall('owner', 'ad_monthly_budget_set', $$1000001, 20, '상한 초과'$$), '22023', 'M11e 상한(100만원) 초과 거부');
select test.expect_error(test.adcall('owner', 'ad_monthly_budget_set', $$10000, 9, '여유 부족'$$), '22023', 'M11f 안전 여유 10% 미만 거부');
select test.expect_error(test.adcall('owner', 'ad_monthly_budget_set', $$10000, 51, '여유 과다'$$), '22023', 'M11g 안전 여유 50% 초과 거부');
select test.expect_error(test.adcall('owner', 'ad_monthly_budget_set', $$10000, 20, ' '$$), '22023', 'M11h 사유 없음 거부');
select test.expect_error(test.adcall('owner', 'ad_monthly_budget_set', $$null, 20, '빈 값'$$), '22023', 'M11i 빈 값 거부');
select test.expect_error($$update core.ad_month_config set monthly_limit_krw = 999999$$, '42501', 'M11j 앱 계정은 설정 표를 직접 고칠 수 없음');
select test.expect_error($$select * from core.ad_month_config$$, '42501', 'M11k 앱 계정은 설정 표를 직접 읽을 수도 없음');
reset role;
select test.expect_error($$delete from core.ad_month_config$$, '42501', 'M11l 설정 행 삭제 금지(관리자 계정도)');
select test.expect_error($$insert into core.ad_month_config (id) values (2)$$, '23514', 'M11m 설정 행은 1개 고정');
select test.expect_eq($$select monthly_limit_krw || '/' || margin_pct from core.ad_month_config$$, '0/20', 'M11n 거부된 시도 뒤에도 값 그대로');

-- 설정: 월 1만원·여유 20% → 판정 한도 8,000원
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_monthly_budget_set', $$10000, 20, '월 예산 시험 설정'$$, 'effective_limit_krw'), '8000', 'MC1 대표 설정: 1만원 × (100−20)% = 판정 한도 8,000원');
select test.expect_eq(test.lx0('reviewer', 'ad_monthly_budget_get', 'effective_limit_krw'), '8000', 'MC1b 검토자 조회 가능');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.monthly_budget_set' and reason = '월 예산 시험 설정'
  and detail = '{"old": {"margin_pct": 20, "monthly_limit_krw": 0}, "new": {"margin_pct": 20, "monthly_limit_krw": 10000}}'::jsonb$$, '1', 'M12 감사 기록: 사유·변경 전후 값');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'ad.%' and (detail::text ~ 'fideon\|staff|token|secret' or coalesce(reason, '') ~ 'fideon\|staff')$$, '0', 'M12b 광고 감사 기록에 토큰·비밀 없음');

-- M2·M3·M4 (오늘 하루 판정 함수: 날짜가 하나라 월 경계와 무관)
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-a', 5000, 'req-mc-a-00000003'$$, 'decision'), 'ALLOW', 'MC2 A 5,000원 허용');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-b', 3001, 'req-mc-b-00000001'$$, 'reason'), 'MONTHLY_CAP_EXCEEDED', 'M3 월 예산 직전(5,000 + 3,001 > 8,000) 새 요청 차단');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-b', 3000, 'req-mc-b-00000002'$$, 'decision'), 'ALLOW', 'M2a 정확히 8,000원 도달은 허용');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-a', 1, 'req-mc-a-00000004'$$, 'reason'), 'MONTHLY_CAP_EXCEEDED', 'M2 도달 뒤 1원도 차단');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-mc-a', 2, 'req-mc-a-00000005'$$, 'reason'), 'MONTHLY_CAP_EXCEEDED', 'M2b 집행 판정 함수도 차단');
reset role;
select test.expect_eq($$select core.ad_account_month((now() at time zone 'Asia/Seoul')::date)::text$$, '8000', 'M4 여러 캠페인(A 5,000 + B 3,000) 합산 = 8,000');

-- M8 지연·불확실 지출: 보고 없음 = 최대 청구액, 늦게 온 더 큰 보고 = 큰 값, 작은 보고로 줄이지 않음
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_performance_record', format('%L, %L, 10, 1, 6000, %L', 'camp-mc-a', (now() at time zone 'Asia/Seoul')::date, 'platform')), 'M8 A 오늘 보고 6,000원(예약 5,000원보다 큼)');
select test.expect_ok(test.adcall('owner', 'ad_performance_record', format('%L, %L, 10, 1, 100, %L', 'camp-mc-b', (now() at time zone 'Asia/Seoul')::date, 'platform')), 'M8b B 오늘 보고 100원(예약 3,000원보다 작음)');
reset role;
select test.expect_eq($$select core.ad_account_month((now() at time zone 'Asia/Seoul')::date)::text$$, '9000', 'M8c 월 사용액 = max(5,000, 6,000) + max(3,000, 100) = 9,000(늦은 큰 보고 반영, 작은 보고로 줄지 않음)');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_monthly_budget_set', $$11875, 20, '판정 한도 9,500원'$$, 'effective_limit_krw'), '9500', 'M8d 판정 한도 9,500원으로 변경');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-b', 1000, 'req-mc-b-00000003'$$, 'reason'), 'MONTHLY_CAP_EXCEEDED', 'M8e 9,000 + 1,000 > 9,500 차단(보고 무시였다면 8,000 + 1,000 허용됐을 값)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-b', 500, 'req-mc-b-00000004'$$, 'decision'), 'ALLOW', 'M8f 9,000 + 500 = 9,500 허용');
select test.expect_eq(test.lx0('owner', 'ad_monthly_budget_get', 'used_krw'), '9500', 'M8g 조회: 이번 달 사용액 9,500');
-- M13 기존 일·계정 일 한도 유지: 월 예산을 넉넉히 올려도 캠페인 일 1만·계정 일 1만은 그대로
select test.expect_eq(test.lx('owner', 'ad_monthly_budget_set', $$1000000, 10, '넉넉한 월 예산'$$, 'effective_limit_krw'), '900000', 'M13 월 예산 100만원(판정 90만)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-b', 7000, 'req-mc-b-00000005'$$, 'reason'), 'DAILY_CAP_EXCEEDED', 'M13b B 캠페인 일 한도(3,500 + 7,000 > 1만) 유지');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-b', 2000, 'req-mc-b-00000006'$$, 'reason'), 'ACCOUNT_DAILY_CAP_EXCEEDED', 'M13c 계정 일 한도(8,500 + 2,000 > 1만) 유지');
-- M14 같은 요청 반복
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-mc-b', 500, 'req-mc-b-00000004'$$, 'reason'), 'DUPLICATE_REQUEST', 'M14 같은 요청 키 재전송은 다시 세지 않음');
reset role;

-- M6 한국 시간 월말·월초 경계(가상 미래 날짜, 판정 함수 직접)
\ir reset_ad_account.sql
update core.ad_month_config set monthly_limit_krw = 10000, margin_pct = 20;
insert into core.ad_exposure (request_key, serve_date, campaign_key, approval_id, max_krw)
select 'req-mc-m6-000000001', d, 'camp-mc-a', (select id from core.ad_budget_approvals where campaign_key = 'camp-mc-a' and state = 'active'), v
  from (values (date '2031-01-31', 4000), (date '2031-02-01', 2000)) t(d, v);
select test.expect_eq($$select core.ad_account_month('2031-01-15') || '/' || core.ad_account_month('2031-02-28') || '/' || core.ad_account_month('2031-03-01')$$, '4000/2000/0', 'M6 1/31은 1월, 2/1은 2월로 따로 집계(3월 0)');
select test.expect_eq($$select core.ad_account_month((timestamptz '2031-01-31 15:30:00+00' at time zone 'Asia/Seoul')::date)::text$$, '2000', 'M6b UTC 1/31 15:30 = KST 2/1 00:30 → 2월(한국 시간 기준)');
select test.expect_eq($$select core.ad_account_month((timestamptz '2031-01-31 14:59:59+00' at time zone 'Asia/Seoul')::date)::text$$, '4000', 'M6c UTC 1/31 14:59:59 = KST 1/31 23:59:59 → 1월');
select test.expect_eq($$select coalesce(core.ad_month_check('2031-01-31', '2031-02-02', 3000), 'OK')$$, 'OK', 'M6d 두 달에 걸친 기간: 1월 4,000 + 3,000·1일 ≤ 8,000, 2월 2,000 + 3,000·2일 = 8,000 허용');
select test.expect_eq($$select core.ad_month_check('2031-01-31', '2031-02-02', 3001)$$, 'MONTHLY_CAP_EXCEEDED', 'M6e 2월 2,000 + 3,001·2일 > 8,000 차단');
select test.expect_eq($$select core.ad_month_check('2031-01-30', '2031-01-31', 2001)$$, 'MONTHLY_CAP_EXCEEDED', 'M6f 1월 4,000 + 2,001·2일 > 8,000 차단');
select test.expect_eq($$select coalesce(core.ad_month_check('2031-03-01', '2031-03-03', 2666), 'OK')$$, 'OK', 'M6g 새 달(3월)은 0원부터 다시(2,666·3일 ≤ 8,000)');
select test.expect_eq($$select core.ad_month_check('2031-03-01', '2031-02-28', 1)$$, 'MONTHLY_CHECK_INVALID', 'M6h 기간 거꾸로 = 차단 사유');
update core.ad_month_config set monthly_limit_krw = 0;
select test.expect_eq($$select core.ad_month_check('2031-03-01', '2031-03-01', 1)$$, 'MONTHLY_BUDGET_UNSET', 'M6i 0원이면 날짜와 무관하게 차단');

-- M9 감시 대상에 월 사용액·판정 한도 포함(감시 역할만)
update core.ad_month_config set monthly_limit_krw = 10000, margin_pct = 20;
select test.expect_eq($$select (api.ad_monitor_targets() ->> 'month_limit_krw') || '/' || (api.ad_monitor_targets() ? 'month_used_krw')::text$$, '8000/true', 'M9 감시 대상: 판정 한도 8,000·이번 달 사용액 제공');
select test.expect_eq($$select has_function_privilege('app_ad_monitor', 'api.ad_monitor_targets()', 'execute')::text || '/' || has_function_privilege('app_staff', 'api.ad_monitor_targets()', 'execute')::text$$, 'true/false', 'M9b 감시 대상 조회는 감시 전용 역할만(직원 계정 불가)');

\ir reset_ad_account.sql
set session_replication_role = replica;
delete from core.ad_performance where campaign_key like 'camp-mc-%';  -- 이 시험이 남긴 가상 보고만 지움(뒤 시험 격리)
set session_replication_role = origin;
update core.ad_month_config set monthly_limit_krw = 1000000, margin_pct = 10;  -- 뒤 시험(동시성·통합)용으로 넉넉히 되돌림
