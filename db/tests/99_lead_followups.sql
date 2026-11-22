-- 대표 직접 연락 동의·후속 연락 목록(0023, PM 11/22 ② 13·14): 서명 필수, 같은 연락처 최신 리드에 연결, 대표만 열람·완료, 추가 전용, 감사에 원문 없음. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
create function test.fu_sql(p_idem text, p_hmac text, p_ver text default 'privacy-test-v1', p_tamper text default null) returns text language plpgsql as $$
declare
  tok text := test.token('lead', array['followup', p_idem, p_hmac, p_ver]);
begin
  return format('select api.followup_request(%L, %L, %L, %L)', tok, p_idem, coalesce(p_tamper, p_hmac), p_ver);
end $$;
create function test.fu_staff(p_who text, p_fn text, p_lead uuid default null) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' else '00000000-0000-4000-8000-000000000006' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' else '10000000-0000-4000-8000-000000000008' end;
begin
  if p_fn = 'list' then return format('select count(*)::text from api.followup_list(%L, %L, %L)', a, s, test.staff_token(a, s)); end if;
  return format('select api.followup_done(%L, %L, %L, %L)', a, s, test.staff_token(a, s), p_lead);
end $$;
select set_config('t.f0', test.lead_sql(repeat('f1', 32), 'fu-test-0000000001', p_ip => repeat('a', 64)), false);
select set_config('t.f_req', test.fu_sql('fu-test-0000000001', repeat('f1', 32)), false);
select set_config('t.f_resend', test.fu_sql('fu-test-0000000001', repeat('f1', 32)), false);
select set_config('t.f1', test.lead_sql(repeat('f1', 32), 'fu-test-0000000002', p_ip => repeat('a', 64)), false);
select set_config('t.f_repeat', test.fu_sql('fu-test-0000000002', repeat('f1', 32)), false);
select set_config('t.f_nolead', test.fu_sql('fu-test-0000000003', repeat('f2', 32)), false);
select set_config('t.f_tamper', test.fu_sql('fu-test-0000000004', repeat('f1', 32), p_tamper => repeat('f3', 32)), false);
select set_config('t.f_badkey', test.fu_sql('bad', repeat('f1', 32)), false);
update core.feature_flags set enabled = true where key = 'lead_form';
set role app_public;
select test.expect_eq(current_setting('t.f0'), 'accepted', 'FU0 접수');
select test.expect_eq(current_setting('t.f_req'), 'requested', 'FU1 동의 기록: 같은 트랜잭션 서명으로 requested');
select test.expect_eq(current_setting('t.f_resend'), 'exists', 'FU2 같은 요청 키 재전송: exists(중복 없음)');
select test.expect_eq(current_setting('t.f1'), 'accepted', 'FU3 같은 연락처 재접수(재문의 처리)');
select test.expect_eq(current_setting('t.f_repeat'), 'requested', 'FU4 재접수의 동의도 기존 최신 리드에 연결');
select test.expect_eq(current_setting('t.f_nolead'), 'skipped', 'FU5 리드 없는 연락처: skipped(기록 없음)');
select test.expect_error(current_setting('t.f_tamper'), '42501', 'FU6 서명 후 연락처 해시 변조 거부');
select test.expect_error(current_setting('t.f_badkey'), '22023', 'FU7 요청 키 형식 오류 거부');
select test.expect_error($$select api.followup_request(null, 'fu-test-0000000009', repeat('f1', 32), 'privacy-test-v1')$$, '42501', 'FU8 서명 없는 직접 호출 거부');
select test.expect_error($$select * from core.lead_followups$$, '42501', 'FU9 공개 역할은 후속 연락 테이블을 읽을 수 없음');
select test.expect_error($$select * from api.followup_list(null, null, null)$$, '42501', 'FU10 공개 역할은 목록 함수 실행 불가');
reset role;
select l.id::text as flead from core.leads l where l.idempotency_key = 'fu-test-0000000001' \gset
select test.expect_eq(format($$select count(*)::text from core.lead_followups where lead_id = %L and event = 'requested'$$, :'flead'), '2', 'FU11 요청 2건(같은 리드, 재전송 제외)');
select test.expect_eq($$select count(*)::text from core.leads where idempotency_key like 'fu-test-%'$$, '1', 'FU12 동의로 새 리드가 생기지 않음');
set role app_staff;
select test.expect_eq(test.fu_staff('owner', 'list'), '1', 'FU13 대표 목록: 대기 1건(리드 단위)');
select test.expect_error(test.fu_staff('editor', 'list'), '42501', 'FU14 대표 외 직원은 목록 열람 불가');
select test.expect_error(test.fu_staff('editor', 'done', :'flead'), '42501', 'FU15 대표 외 직원은 완료 처리 불가');
select test.expect_ok(test.fu_staff('owner', 'done', :'flead'), 'FU16 대표 완료 처리');
select test.expect_eq(test.fu_staff('owner', 'list'), '0', 'FU17 완료 후 목록에서 빠짐');
select test.expect_error_msg(test.fu_staff('owner', 'done', :'flead'), '22023', 'NOT_PENDING', 'FU18 대기 아닌 리드 완료 거부');
reset role;
select test.expect_error($$update core.lead_followups set event = 'done'$$, '42501', 'FU19 기록 수정 불가(추가 전용)');
select test.expect_error($$delete from core.lead_followups$$, '42501', 'FU19b 기록 삭제 불가');
select test.expect_error($$truncate core.lead_followups$$, '42501', 'FU19c 비우기 불가');
select test.expect_eq($$select count(*)::text from core.audit_logs where action in ('followup.request', 'followup.done')$$, '3', 'FU20 감사 기록 3건(요청 2·완료 1)');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'followup.%' and (detail::text ~ '[0-9a-f]{64}' or detail::text like '%enc%' or detail::text like '%평일%')$$, '0', 'FU20b 감사에 연락처 해시·암호문·자유 문장 없음');
-- 새 요청이 오면 다시 대기 목록에 오른다
select set_config('t.f_again', test.fu_sql('fu-test-0000000005', repeat('f1', 32)), false);
set role app_public;
select test.expect_eq(current_setting('t.f_again'), 'requested', 'FU21 완료 뒤 재요청 기록');
set role app_staff;
select test.expect_eq(test.fu_staff('owner', 'list'), '1', 'FU22 재요청은 다시 대기 목록에 오름');
reset role;
