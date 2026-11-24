-- 0035 광고 자동 스케줄러·PAUSED → ENABLED 안전 자동전환(PM 11/25 ②③) DB 판정. 가상 데이터만, 실제 Google Ads 호출·광고비 없음.
-- 동시 실행(여러 서버 100건)은 scripts/db-test.sh가 병렬 psql로 시험한다.
\set ON_ERROR_STOP 1
\ir reset_ad_account.sql
set session_replication_role = replica;
delete from core.ad_enable_jobs;
delete from core.ad_keyword_registry;
set session_replication_role = origin;
update core.ad_cpc_policy set max_cpc_krw = 0;
-- 기본값
select test.expect_eq($$select max_cpc_krw::text || '/' || (select count(*) from core.ad_keyword_registry)::text || '/' || (select count(*) from core.ad_enable_jobs)::text from core.ad_cpc_policy$$, '0/0/0', 'EN0 기본: CPC 정책 0원(미설정)·승인 키워드 0개·예약 0건');

-- 준비: 감시 정상 → 승인 → launch(PAUSED 생성 흉내: 모의 외부 ID) → 집행 기간 예약
set role app_ad_monitor;
select api.ad_monitor_record(true, '{}'::jsonb);
reset role;
set role app_staff;
select test.expect_ok(test.adapprove('owner', 'camp-en', 4000, 12000, 72, '활성화 시험 승인'), 'EN1 예산 승인');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-en', 'req-en-launch-0001', 4000$$, 'ok'), 'true', 'EN1b launch 시작');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-en', 4000, 'req-en-launch-0001'$$, 'decision'), 'ALLOW', 'EN1c 집행 기간 예산 예약');
select test.expect_ok(test.adcall('owner', 'ad_launch_finish', $$'req-en-launch-0001', 'active', 'mock-en-1', null$$), 'EN1d launch active(PAUSED 캠페인 생성됨)');

-- 승인 경계: 키워드·CPC 미설정이면 예약 불가
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L], %L, 100, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', repeat('a', 64), '활성화 예약'), 'reason'), 'KEYWORD_NOT_APPROVED', 'EN2 승인 키워드 없음 → 예약 불가');
select test.expect_error(test.adcall('editor', 'ad_keyword_approve', $$'이사 인터넷 설치', '권한 우회'$$), '42501', 'EN2b 정책 편집자는 키워드 승인 불가');
select test.expect_error(test.adcall('reviewer', 'ad_keyword_approve', $$'이사 인터넷 설치', '권한 우회'$$), '42501', 'EN2c 검토자도 키워드 승인 불가');
select test.expect_error(test.adcall('owner', 'ad_keyword_approve', $$'이사 인터넷 설치!', 'PM 승인'$$), '22023', 'EN2d 형식 밖 키워드 거부');
select test.expect_ok(test.adcall('owner', 'ad_keyword_approve', $$'이사 인터넷 설치', 'PM 승인 키워드(가상)'$$), 'EN2e 대표가 PM 승인 키워드 등록(EXACT)');
select test.expect_ok(test.adcall('owner', 'ad_keyword_approve', $$'새집 인터넷', 'PM 승인 키워드(가상)'$$), 'EN2f 두 번째 키워드');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L], %L, 100, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', repeat('a', 64), '활성화 예약'), 'reason'), 'CPC_POLICY_UNSET', 'EN3 CPC 정책 미설정 → 예약 불가');
select test.expect_error(test.adcall('reviewer', 'ad_cpc_policy_set', $$300, '권한 우회'$$), '42501', 'EN3b 검토자는 CPC 정책 변경 불가');
select test.expect_error(test.adcall('owner', 'ad_cpc_policy_set', $$10001, '상한 초과'$$), '22023', 'EN3c CPC 상한 초과 거부');
select test.expect_eq(test.lx('owner', 'ad_cpc_policy_set', $$300, 'PM 승인 CPC(가상)'$$, 'max_cpc_krw'), '300', 'EN3d 대표가 CPC 정책 설정');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L], %L, 301, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', repeat('a', 64), '활성화 예약'), 'reason'), 'CPC_OVER_POLICY', 'EN3e 정책보다 높은 CPC → 예약 불가');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L, %L], %L, 100, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', '이사인터넷 설치', repeat('a', 64), '활성화 예약'), 'reason'), 'KEYWORDS_INVALID', 'EN3f 띄어쓰기만 다른 중복 키워드 → 예약 불가');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() - interval ''1 minute'', array[%L], %L, 100, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', repeat('a', 64), '활성화 예약'), 'reason'), 'RUN_AT_INVALID', 'EN3g 과거 실행 시각 거부');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L], %L, 100, %L', 'camp-en', 'req-en-other-00001', '이사 인터넷 설치', repeat('a', 64), '활성화 예약'), 'reason'), 'NO_ACTIVE_LAUNCH', 'EN3h 다른 launch 키(생성 안 된 캠페인) → 예약 불가');
select test.expect_error(test.adcall('editor', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L], %L, 100, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', repeat('a', 64), '권한 우회')), '42501', 'EN3i 정책 편집자는 활성화 예약 불가');
-- 정상 예약
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L, %L], %L, 250, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', '새집 인터넷', repeat('a', 64), '대표 명시 승인: 활성화 예약'), 'ok'), 'true', 'EN4 대표 명시 승인 → 1시간 뒤 활성화 예약');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''2 hour'', array[%L], %L, 250, %L', 'camp-en', 'req-en-launch-0001', '이사 인터넷 설치', repeat('a', 64), '중복 예약'), 'reason'), 'JOB_OPEN', 'EN4b 캠페인당 열린 예약 1건');
select test.expect_error($$select * from core.ad_enable_jobs$$, '42501', 'EN4c 앱 계정은 예약 표를 직접 읽을 수 없음');
select test.expect_error($$update core.ad_cpc_policy set max_cpc_krw = 9999$$, '42501', 'EN4d 앱 계정은 CPC 정책을 직접 고칠 수 없음');
select test.expect_error($$select api.ad_sched_claim(gen_random_uuid())$$, '42501', 'EN4e 직원 계정은 스케줄러 함수 실행 불가');
reset role;

-- 스케줄러 함수는 전용 역할만 실행(아래 동작 시험은 관리 계정으로 같은 함수를 부른다: security definer라 결과 동일)
select test.expect_eq($$select string_agg(has_function_privilege('app_ad_scheduler', f, 'execute')::text || has_function_privilege('app_staff', f, 'execute')::text || has_function_privilege('app_ad_monitor', f, 'execute')::text, ',') from unnest(array['api.ad_sched_claim(uuid)', 'api.ad_sched_gate(uuid,uuid)', 'api.ad_sched_finish(uuid,uuid,text,text)']) f$$, 'truefalsefalse,truefalsefalse,truefalsefalse', 'EN4f 스케줄러 함수 3개: 전용 역할만 실행(직원·감시 역할 불가)');
-- 실행 시각 전에는 잡히지 않음
select test.expect_eq($$select (api.ad_sched_claim('aaaaaaaa-0000-4000-8000-000000000001') -> 'job')::text$$, 'null', 'EN5 실행 시각 전 → 잡을 예약 없음(집행 0)');
-- 실행 시각 도달(시험: 예약 시각만 과거로)
update core.ad_enable_jobs set run_at = now() - interval '1 second' where campaign_key = 'camp-en';
select test.expect_eq($$select api.ad_sched_claim('aaaaaaaa-0000-4000-8000-000000000002') #>> '{job,external_id}'$$, 'mock-en-1', 'EN6 실행 시각 뒤 1건 잡음(외부 ID 함께)');
select test.expect_eq($$select (api.ad_sched_claim('aaaaaaaa-0000-4000-8000-000000000003') -> 'job')::text$$, 'null', 'EN6b 다른 회차는 같은 예약을 다시 못 잡음(중복 실행 차단)');
select test.expect_eq($$select api.ad_sched_gate((select id from core.ad_enable_jobs where campaign_key = 'camp-en' limit 1), 'aaaaaaaa-0000-4000-8000-000000000003') ->> 'reason'$$, 'JOB_NOT_CLAIMED', 'EN6c 잡지 않은 회차는 판정 불가');
select test.expect_eq($$select state from core.ad_enable_jobs where campaign_key = 'camp-en'$$, 'running', 'EN6d 잘못된 회차 시도 뒤에도 실행 중 그대로');
-- 판정 통과 → 결과 기록
select test.expect_eq($$select api.ad_sched_gate((select id from core.ad_enable_jobs where campaign_key = 'camp-en' limit 1), 'aaaaaaaa-0000-4000-8000-000000000002') ->> 'decision'$$, 'ALLOW', 'EN7 실행 직전 최종 판정 통과(승인·키워드·CPC·기간·월/일/계정 예산·감시)');
select test.expect_ok($$select api.ad_sched_finish((select id from core.ad_enable_jobs where campaign_key = 'camp-en' limit 1), 'aaaaaaaa-0000-4000-8000-000000000002', 'enabled', null)$$, 'EN7b 다시 읽어 ENABLED 확인 뒤 enabled 기록');
select test.expect_error($$select api.ad_sched_finish((select id from core.ad_enable_jobs where campaign_key = 'camp-en' limit 1), 'aaaaaaaa-0000-4000-8000-000000000002', 'enabled', null)$$, '55000', 'EN7c 같은 결과 두 번 기록 불가');
select test.expect_eq($$select string_agg(action, ',' order by id) from core.audit_logs where action like 'ad.enable_%' and target_id = (select id from core.ad_enable_jobs where campaign_key = 'camp-en' limit 1)$$, 'ad.enable_scheduled,ad.enable_claim,ad.enable_allow,ad.enable_enabled', 'EN7d 감사: 예약 → 잡음 → 판정 → 활성');

-- 승인 취소 시 자동 중지: 키워드 철회 → 활성 캠페인 예산 승인 철회(정기 감시가 NO_ACTIVE_APPROVAL로 중지)
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_keyword_revoke', $$'새집 인터넷', 'PM 승인 철회(가상)'$$, 'revoked_approvals'), '1', 'EN8 키워드 철회 → 그 키워드를 쓴 활성 캠페인 예산 승인 철회 1건');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-en', 100, 'req-en-after-00001'$$, 'reason'), 'NO_APPROVAL', 'EN8b 철회 뒤 새 지출 차단');
reset role;
select test.expect_eq($$select count(*)::text from core.ad_budget_approvals where campaign_key = 'camp-en' and state = 'active'$$, '0', 'EN8c 활성 승인 0(감시 중지 대상)');

-- 실행 직전 판정 차단: 예산 승인 없음·월 예산 미설정·감시 정지·경고 열림·대표 비활성
\ir reset_ad_account.sql
set role app_ad_monitor;
select api.ad_monitor_record(true, '{}'::jsonb);
reset role;
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_keyword_approve', $$'새집 인터넷', 'PM 재승인(가상)'$$), 'EN9 키워드 재등록');
select test.expect_ok(test.adapprove('owner', 'camp-en2', 4000, 12000, 72, '활성화 시험 승인 2'), 'EN9b 예산 승인');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-en2', 'req-en-launch-0002', 4000$$, 'ok'), 'true', 'EN9c launch');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-en2', 4000, 'req-en-launch-0002'$$, 'decision'), 'ALLOW', 'EN9d 예약');
select test.expect_ok(test.adcall('owner', 'ad_launch_finish', $$'req-en-launch-0002', 'active', 'mock-en-2', null$$), 'EN9e active');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L], %L, 100, %L', 'camp-en2', 'req-en-launch-0002', '새집 인터넷', repeat('b', 64), '예약 2'), 'ok'), 'true', 'EN9f 예약');
reset role;
update core.ad_enable_jobs set run_at = now() - interval '1 second' where campaign_key = 'camp-en2';
update core.ad_month_config set monthly_limit_krw = 0;
select api.ad_sched_claim('bbbbbbbb-0000-4000-8000-000000000001');
select test.expect_eq($$select api.ad_sched_gate((select id from core.ad_enable_jobs where campaign_key = 'camp-en2' limit 1), 'bbbbbbbb-0000-4000-8000-000000000001') ->> 'reason'$$, 'MONTHLY_BUDGET_UNSET', 'EN10 월 예산 0원이면 실행 직전에도 차단(ENABLED 요청 없음)');
select test.expect_eq($$select state || '/' || result_code from core.ad_enable_jobs where campaign_key = 'camp-en2'$$, 'blocked/MONTHLY_BUDGET_UNSET', 'EN10b 예약은 blocked로 닫힘(재시도 없음)');
update core.ad_month_config set monthly_limit_krw = 1000000, margin_pct = 10;
-- 판정 함수 직접: 각 차단 사유(실행 시각 기준)
select test.expect_eq($$select coalesce(core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 100, now()), 'OK')$$, 'OK', 'EN11 대조군: 조건 모두 맞으면 통과');
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 100, now() + interval '5 days')$$, 'APPROVAL_EXPIRED', 'EN11b 승인 만료 뒤 → 차단');
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 100, now() + interval '3 hours')$$, 'MONITOR_STALE', 'EN11c 정기 감시 2시간 넘게 멈춤 → 차단(감시 실패 경고 경로)');
insert into core.ad_monitor_runs (ok, detail) values (false, '{"t": "en"}');
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 100, now())$$, 'MONITOR_NOT_OK', 'EN11d 마지막 감시 불명 → 차단');
insert into core.ad_monitor_runs (ok, detail) values (true, '{"t": "en"}');
insert into core.ad_alerts (campaign_key, kind, detail, created_by) values ('camp-other', 'stop_failed', '{}', '00000000-0000-4000-8000-000000000001');
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 100, now())$$, 'STOP_PENDING', 'EN11e 다른 캠페인 중지 실패 경고 열림 → 차단');
set session_replication_role = replica;
delete from core.ad_alerts where campaign_key = 'camp-other';
set session_replication_role = origin;
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 100, (date_trunc('day', now() at time zone 'Asia/Seoul') + interval '3 days 1 second') at time zone 'Asia/Seoul')$$, 'OUTSIDE_WINDOW', 'EN11f 승인은 남았어도 예산 예약 기간(3개 날짜) 밖 → 차단');
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷', '없는 키워드'], 100, now())$$, 'KEYWORD_NOT_APPROVED', 'EN11g 실행 시점에 승인 목록 밖 키워드 섞이면 차단');
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 301, now())$$, 'CPC_OVER_POLICY', 'EN11h 실행 시점 CPC 정책 초과 차단');
update core.ad_cpc_policy set max_cpc_krw = 0;
select test.expect_eq($$select core.ad_enable_check('camp-en2', 'req-en-launch-0002', array['새집 인터넷'], 100, now())$$, 'CPC_POLICY_UNSET', 'EN11i 실행 시점 CPC 정책 0원 차단');
update core.ad_cpc_policy set max_cpc_krw = 300;
update core.staff set active = false where user_id = '00000000-0000-4000-8000-000000000001';
update core.ad_enable_jobs set state = 'running', run_id = 'cccccccc-0000-4000-8000-000000000001', claimed_at = now(), result_code = null where campaign_key = 'camp-en2';
select test.expect_eq($$select api.ad_sched_gate((select id from core.ad_enable_jobs where campaign_key = 'camp-en2' limit 1), 'cccccccc-0000-4000-8000-000000000001') ->> 'reason'$$, 'APPROVER_INACTIVE', 'EN12 예약한 대표가 비활성화되면 실행 차단');
update core.staff set active = true where user_id = '00000000-0000-4000-8000-000000000001';

-- 10분 넘게 끝나지 않은 실행 = 불명 + 경고(자동 재시도 없음, 계정 전체 새 지출 차단)
update core.ad_enable_jobs set state = 'running', claimed_at = now() - interval '11 minutes', result_code = null where campaign_key = 'camp-en2';
select api.ad_sched_claim('cccccccc-0000-4000-8000-000000000002');
select test.expect_eq($$select state || '/' || result_code || '/' || (select count(*) from core.ad_alerts where campaign_key = 'camp-en2' and state = 'open')::text from core.ad_enable_jobs where campaign_key = 'camp-en2'$$, 'unknown/RUN_TIMEOUT/1', 'EN13 시간 초과 실행 → unknown·경고 열림');
-- 결과 unknown 기록도 경고
\ir reset_ad_account.sql
set session_replication_role = replica;
delete from core.ad_enable_jobs;
set session_replication_role = origin;
update core.ad_cpc_policy set max_cpc_krw = 0;

-- EN14 경합: 최종 판정(ALLOW) 직후 대표가 예산 승인을 철회하면, 매체 활성화 뒤 결과 기록(enabled)을 거부해야 한다(성공으로 남기지 않음 → 서버가 즉시 중지)
set role app_ad_monitor;
select api.ad_monitor_record(true, '{}'::jsonb);
reset role;
update core.ad_cpc_policy set max_cpc_krw = 300;
set role app_staff;
select test.expect_ok(test.adapprove('owner', 'camp-rv', 4000, 12000, 72, '경합 재현 승인'), 'EN14a 예산 승인');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-rv', 'req-rv-launch-00001', 4000$$, 'ok'), 'true', 'EN14b launch');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-rv', 4000, 'req-rv-launch-00001'$$, 'decision'), 'ALLOW', 'EN14c 예약');
select test.expect_ok(test.adcall('owner', 'ad_launch_finish', $$'req-rv-launch-00001', 'active', 'mock-rv-1', null$$), 'EN14d active');
select test.expect_eq(test.lx('owner', 'ad_enable_schedule', format('%L, %L, now() + interval ''1 hour'', array[%L], %L, 100, %L', 'camp-rv', 'req-rv-launch-00001', '새집 인터넷', repeat('d', 64), '경합 예약'), 'ok'), 'true', 'EN14e 예약');
reset role;
update core.ad_enable_jobs set run_at = now() - interval '1 second' where campaign_key = 'camp-rv';
select api.ad_sched_claim('dddddddd-0000-4000-8000-000000000001');
select test.expect_eq($$select api.ad_sched_gate((select id from core.ad_enable_jobs where campaign_key = 'camp-rv' limit 1), 'dddddddd-0000-4000-8000-000000000001') ->> 'decision'$$, 'ALLOW', 'EN14f 최종 판정 통과');
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_budget_revoke', $$'camp-rv', '판정 직후 승인 철회'$$), 'EN14g 판정 직후 대표가 승인 철회');
reset role;
select test.expect_error($$select api.ad_sched_finish((select id from core.ad_enable_jobs where campaign_key = 'camp-rv' limit 1), 'dddddddd-0000-4000-8000-000000000001', 'enabled', 'ENABLED')$$, '55000', 'EN14h 활성화 뒤 결과 기록 시 다시 판정: 승인 철회면 enabled 기록 거부(서버가 즉시 중지)');
select test.expect_eq($$select state from core.ad_enable_jobs where campaign_key = 'camp-rv'$$, 'running', 'EN14i 거부 뒤 예약은 실행 중으로 남아 10분 뒤 unknown·경고(EN13 경로)');
select test.expect_ok($$select api.ad_sched_finish((select id from core.ad_enable_jobs where campaign_key = 'camp-rv' limit 1), 'dddddddd-0000-4000-8000-000000000001', 'unknown', 'STOPPED')$$, 'EN14j 실패·불명 기록은 다시 판정 없이 허용(중지 기록이 막히지 않음)');
\ir reset_ad_account.sql
set session_replication_role = replica;
delete from core.ad_enable_jobs;
set session_replication_role = origin;
update core.ad_cpc_policy set max_cpc_krw = 0;
