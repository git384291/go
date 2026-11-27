-- 광고성 전화 수신거부·시도·판정 기록 영구화(0070, 코사장 11/27): 추가 전용, DB가 3회·24시간 강제, 사업자 격리, 역할 제한, 원문 없음. 가상 HMAC만.
\set ON_ERROR_STOP 1
reset role;
select set_config('t.h1', repeat('1a', 32), false);
select set_config('t.h2', repeat('2b', 32), false);
select set_config('t.h3', repeat('3c', 32), false);
set role app_call;
-- 수신거부
select test.expect_eq(format($$select result from api.outbound_suppression_check('bareun365', %L)$$, current_setting('t.h1')), 'clear', 'OP1 처음엔 clear');
select test.expect_eq(format($$select api.outbound_suppression_block('bareun365', %L)$$, current_setting('t.h1')), 'blocked', 'OP2 수신거부 기록');
select test.expect_eq(format($$select api.outbound_suppression_block('bareun365', %L)$$, current_setting('t.h1')), 'blocked', 'OP3 같은 번호 다시 기록해도 멱등');
select test.expect_eq(format($$select result from api.outbound_suppression_check('bareun365', %L)$$, current_setting('t.h1')), 'blocked', 'OP4 조회 blocked');
select test.expect_eq(format($$select result from api.outbound_suppression_check('other-dealer', %L)$$, current_setting('t.h1')), 'clear', 'OP5 타 사업자 격리(다른 사업자에는 영향 없음)');
select test.expect_error_msg($$select api.outbound_suppression_block('bareun365', '01012345678')$$, '22023', 'INVALID_INPUT', 'OP6 전화번호 원문 거부');
select test.expect_error_msg(format($$select api.outbound_suppression_block('Bareun 365', %L)$$, current_setting('t.h1')), '22023', 'INVALID_INPUT', 'OP7 사업자 ID 형식 오류 거부');
select test.expect_error_msg(format($$select api.outbound_suppression_block('bareun365', %L)$$, upper(current_setting('t.h2'))), '22023', 'INVALID_INPUT', 'OP8 대문자 HMAC 거부');
-- 시도: DB가 직접 센다
select test.expect_error_msg(format($$select api.outbound_attempt_begin('bareun365', %L, 'ad-internet-tv', 'live_agent', 'manual')$$, current_setting('t.h1')), '22023', 'OPTED_OUT', 'OP9 수신거부 번호 시도 거부');
select test.expect_ok(format($$select api.outbound_attempt_begin('bareun365', %L, 'ad-internet-tv', 'live_agent', 'manual')$$, current_setting('t.h2')), 'OP10 첫 시도 기록');
select test.expect_error_msg(format($$select api.outbound_attempt_begin('bareun365', %L, 'ad-internet-tv', 'live_agent', 'manual')$$, current_setting('t.h2')), '22023', 'RETRY_TOO_SOON', 'OP11 24시간 안 재시도 거부');
select test.expect_ok(format($$select api.outbound_attempt_begin('other-dealer', %L, 'ad-internet-tv', 'live_agent', 'manual')$$, current_setting('t.h2')), 'OP12 타 사업자는 별도 집계');
select test.expect_error_msg(format($$select api.outbound_attempt_begin('bareun365', %L, 'ad-internet-tv', 'robocall', 'manual')$$, current_setting('t.h3')), '22023', 'INVALID_INPUT', 'OP13 모드 형식 오류 거부');
reset role;
-- 과거 시도 2건을 가상으로 넣어(25·50시간 전) 누적 3회 경계를 만든다(시각 조작 불가 → 관리 역할로 과거 행 삽입)
insert into core.outbound_attempts (business_id, phone_hmac, purpose_id, mode, dialer, attempted_at)
values ('bareun365', current_setting('t.h3'), 'ad-internet-tv', 'live_agent', 'manual', now() - interval '50 hours'),
       ('bareun365', current_setting('t.h3'), 'ad-internet-tv', 'live_agent', 'manual', now() - interval '25 hours');
set role app_call;
select test.expect_eq(format($$select total || '/' || recent_24h || '/' || can_attempt from api.outbound_attempt_status('bareun365', %L)$$, current_setting('t.h3')), '2/0/true', 'OP14 현황: 누적 2·최근 0·시작 가능(24시간 지남)');
select test.expect_ok(format($$select api.outbound_attempt_begin('bareun365', %L, 'ad-internet-tv', 'live_agent', 'manual')$$, current_setting('t.h3')), 'OP15 3번째 시도(24시간 경계 지남) 기록');
select test.expect_eq(format($$select total || '/' || recent_24h || '/' || can_attempt from api.outbound_attempt_status('bareun365', %L)$$, current_setting('t.h3')), '3/1/false', 'OP16 현황: 누적 3·시작 불가');
reset role;
insert into core.outbound_attempts (business_id, phone_hmac, purpose_id, mode, dialer, attempted_at)
values ('bareun365', repeat('4d', 32), 'ad-internet-tv', 'live_agent', 'manual', now() - interval '100 hours'),
       ('bareun365', repeat('4d', 32), 'ad-internet-tv', 'live_agent', 'manual', now() - interval '75 hours'),
       ('bareun365', repeat('4d', 32), 'ad-internet-tv', 'live_agent', 'manual', now() - interval '50 hours');
set role app_call;
select test.expect_error_msg(format($$select api.outbound_attempt_begin('bareun365', %L, 'ad-internet-tv', 'live_agent', 'manual')$$, repeat('4d', 32)), '22023', 'RETRY_LIMIT', 'OP17 누적 3회면 24시간 지나도 거부');
-- 결과 기록
reset role;
select a.id::text as att from core.outbound_attempts a where a.business_id = 'bareun365' and a.phone_hmac = repeat('2b', 32) \gset
set role app_call;
select test.expect_error_msg(format($$select api.outbound_attempt_finish('other-dealer', %s, 'placed')$$, :'att'), '22023', 'NOT_FOUND', 'OP18a 타 사업자 시도 ID로 결과 기록 거부');
select test.expect_ok(format($$select api.outbound_attempt_finish('bareun365', %s, 'placed')$$, :'att'), 'OP18 결과 기록');
select test.expect_error_msg(format($$select api.outbound_attempt_finish('bareun365', %s, 'dial_failed')$$, :'att'), '22023', 'ALREADY_RECORDED', 'OP19 결과 2번 기록 거부');
select test.expect_error_msg($$select api.outbound_attempt_finish('bareun365', 999999999, 'placed')$$, '22023', 'NOT_FOUND', 'OP20 없는 시도 거부');
-- 판정 기록
select test.expect_ok(format($$select api.outbound_decision_record('bareun365', %L, true, 'live_exception', '{}')$$, current_setting('t.h2')), 'OP21 허용 판정 기록');
select test.expect_ok(format($$select api.outbound_decision_record('bareun365', %L, false, null, array['NIGHT_BLOCKED','DNC_UNCONFIRMED'])$$, current_setting('t.h2')), 'OP22 차단 판정 기록');
select test.expect_error_msg(format($$select api.outbound_decision_record('bareun365', %L, false, null, array['010-1234-5678'])$$, current_setting('t.h2')), '22023', 'INVALID_INPUT', 'OP23 사유에 전화번호 등 자유 문자열 거부');
select test.expect_error_msg(format($$select api.outbound_decision_record('bareun365', %L, true, null, '{}')$$, current_setting('t.h2')), '22023', 'INVALID_INPUT', 'OP24 허용인데 근거 없음 거부');
select test.expect_error_msg(format($$select api.outbound_decision_record('bareun365', %L, false, null, '{}')$$, current_setting('t.h2')), '22023', 'INVALID_INPUT', 'OP25 차단인데 사유 없음 거부');
-- 직접 표 접근 거부(통화 작업자 역할)
select test.expect_error($$select * from core.outbound_suppressions$$, '42501', 'OP26 app_call 수신거부 표 직접 SELECT 불가');
select test.expect_error(format($$insert into core.outbound_suppressions (business_id, phone_hmac) values ('bareun365', %L)$$, current_setting('t.h3')), '42501', 'OP27 직접 INSERT 불가');
select test.expect_error($$update core.outbound_decisions set allowed = true$$, '42501', 'OP28 직접 UPDATE 불가');
select test.expect_error($$delete from core.outbound_attempts$$, '42501', 'OP29 직접 DELETE 불가');
reset role;
-- 공개·관리자 역할은 함수 실행 불가
set role app_public;
select test.expect_error(format($$select api.outbound_suppression_check('bareun365', %L)$$, current_setting('t.h1')), '42501', 'OP30 공개 역할 조회 함수 실행 불가');
select test.expect_error(format($$select api.outbound_suppression_block('bareun365', %L)$$, current_setting('t.h3')), '42501', 'OP31 공개 역할 수신거부 기록 불가');
reset role;
set role app_staff;
select test.expect_error(format($$select api.outbound_attempt_begin('bareun365', %L, 'ad-internet-tv', 'live_agent', 'manual')$$, current_setting('t.h3')), '42501', 'OP32 관리자 역할 시도 함수 실행 불가');
reset role;
-- 관리 역할로도 추가 전용(해제·수정·삭제 불가)
select test.expect_error(format($$delete from core.outbound_suppressions where phone_hmac = %L$$, current_setting('t.h1')), '42501', 'OP33 수신거부 해제(삭제) 불가');
select test.expect_error($$update core.outbound_suppressions set business_id = 'x'$$, '42501', 'OP34 수신거부 수정 불가');
select test.expect_error($$truncate core.outbound_decisions$$, '42501', 'OP35 판정 기록 비우기 불가');
select test.expect_error($$update core.outbound_attempt_results set result = 'placed'$$, '42501', 'OP36 결과 수정 불가');
select test.expect_eq($$select count(*)::text from (select business_id || phone_hmac || coalesce(basis,'') || array_to_string(reasons, ',') as x from core.outbound_decisions
   union all select business_id || phone_hmac || purpose_id || mode || dialer from core.outbound_attempts) q where x ~ '01[016789][0-9]{7,8}'$$, '0', 'OP37 기록에 전화번호 원문 없음');
select test.expect_eq($$select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'core' and c.relname in ('outbound_suppressions','outbound_attempts','outbound_attempt_results','outbound_decisions') and c.relrowsecurity and c.relforcerowsecurity$$, '4', 'OP38 4개 표 RLS enable+force');
