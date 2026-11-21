-- 재접수 변경 요청(0019): 같은 내용은 저장 0, 다른 내용은 추가 전용 암호화 기록, 원본 불변, 서명·대표 전용 열람·감사 원문 없음. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
create function test.amd_sql(p_idem text, p_hmac text, p_payload text, p_ch text, p_tamper text default null) returns text language plpgsql as $$
declare
  s text := format('{"answered":7,"missing":[],"contentHmac":"%s"}', p_ch);
  tok text := test.token('lead', array['amendment', p_idem, p_hmac, p_payload, s, p_ch]);
begin
  return format('select api.application_amend(%L, %L, %L, %L, %L, %L)', tok, p_idem, p_hmac, coalesce(p_tamper, p_payload), s, p_ch);
end $$;
create function test.amd_list(p_who text, p_lead uuid) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'editor' then '00000000-0000-4000-8000-000000000006'
                       when 'reviewer' then '00000000-0000-4000-8000-000000000005' else '00000000-0000-4000-8000-000000000004' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'editor' then '10000000-0000-4000-8000-000000000008'
                       when 'reviewer' then '10000000-0000-4000-8000-000000000005' else '10000000-0000-4000-8000-000000000004' end;
begin
  return format('select count(*)::text from api.application_amendments(%L, %L, %L, %L)', a, s, test.staff_token(a, s), p_lead);
end $$;
-- 원본: 정상 접수 1건 + 원본 신청서(요약에 contentHmac)
select set_config('t.m0', test.lead_sql(repeat('a7', 32), 'amd-test-0000000001', p_ip => repeat('c', 64)), false);
select set_config('t.ms', test.app_sql('amd-test-0000000001', 'v1:orig', format('{"answered":7,"missing":[],"contentHmac":"%s"}', repeat('1', 64))), false);
-- 같은 연락처 재접수(create_lead는 재문의로 처리, 리드 없음) 뒤 변경 요청 판정
select set_config('t.m1', test.lead_sql(repeat('a7', 32), 'amd-test-0000000002', p_ip => repeat('c', 64)), false);
select set_config('t.a_same', test.amd_sql('amd-test-0000000002', repeat('a7', 32), 'v1:same', repeat('1', 64)), false);
select set_config('t.a_diff', test.amd_sql('amd-test-0000000003', repeat('a7', 32), 'v1:addr2', repeat('2', 64)), false);
select set_config('t.a_diff_again', test.amd_sql('amd-test-0000000004', repeat('a7', 32), 'v1:addr2b', repeat('2', 64)), false);
select set_config('t.a_resend', test.amd_sql('amd-test-0000000003', repeat('a7', 32), 'v1:addr2', repeat('2', 64)), false);
select set_config('t.a_diff3', test.amd_sql('amd-test-0000000005', repeat('a7', 32), 'v1:carrier3', repeat('3', 64)), false);
select set_config('t.a_nolead', test.amd_sql('amd-test-0000000006', repeat('b8', 32), 'v1:x', repeat('4', 64)), false);
select set_config('t.a_tamper', test.amd_sql('amd-test-0000000007', repeat('a7', 32), 'v1:x', repeat('5', 64), 'v1:tampered'), false);
select set_config('t.a_plain', test.amd_sql('amd-test-0000000008', repeat('a7', 32), 'plain-address', repeat('6', 64)), false);
update core.feature_flags set enabled = true where key = 'lead_form';
set role app_public;
select test.expect_eq(current_setting('t.m0'), 'accepted', 'AM0 원본 접수');
select test.expect_eq(current_setting('t.ms'), 'saved', 'AM0b 원본 신청서 저장');
select test.expect_eq(current_setting('t.m1'), 'accepted', 'AM0c 같은 연락처 재접수: 응답은 접수(재문의 처리)');
select test.expect_eq(current_setting('t.a_same'), 'same', 'AM1 원본과 같은 내용: same(저장 없음)');
select test.expect_eq(current_setting('t.a_diff'), 'amended', 'AM2 다른 내용: 변경 요청 1건 추가');
select test.expect_eq(current_setting('t.a_diff_again'), 'same', 'AM3 이미 받은 변경 요청과 같은 내용: same(중복 저장 없음)');
select test.expect_eq(current_setting('t.a_resend'), 'amended', 'AM4 같은 요청 키 재전송: 이미 처리됨(추가 저장 없음)');
select test.expect_eq(current_setting('t.a_diff3'), 'amended', 'AM5 또 다른 변경(통신사 등): 두 번째 변경 요청');
select test.expect_eq(current_setting('t.a_nolead'), 'skipped', 'AM6 기존 리드 없는 연락처: skipped');
select test.expect_error(current_setting('t.a_tamper'), '42501', 'AM7 서명 후 본문 변조 거부');
select test.expect_error(current_setting('t.a_plain'), '22023', 'AM8 암호문 형식이 아니면 거부(평문 주소 저장 불가)');
select test.expect_error($$select api.application_amend(null, 'amd-test-0000000009', repeat('a7', 32), 'v1:x', '{}', repeat('7', 64))$$, '42501', 'AM9 서명 없는 직접 호출 거부');
select test.expect_error($$select * from pii.lead_amendments$$, '42501', 'AM10 공개 역할은 변경 요청 테이블을 읽을 수 없음');
reset role;
select l.id::text as mlead from core.leads l where l.idempotency_key = 'amd-test-0000000001' \gset
select test.expect_eq(format($$select count(*)::text from pii.lead_amendments where lead_id = %L$$, :'mlead'), '2', 'AM11 변경 요청은 2건(다른 내용만, 중복·같은 내용 제외)');
select test.expect_eq($$select count(*)::text from core.leads where idempotency_key like 'amd-test-%'$$, '1', 'AM12 재접수로 새 리드 0건');
select test.expect_eq(format($$select payload_enc || '|' || (summary->>'contentHmac') from pii.lead_applications where lead_id = %L$$, :'mlead'), 'v1:orig|' || repeat('1', 64), 'AM13 원본 신청서 본문·해시 불변(덮어쓰기 없음)');
select test.expect_eq(format($$select count(*)::text from core.lead_status_history where lead_id = %L and reason = 'repeat_inquiry'$$, :'mlead'), '1', 'AM14 재문의 기록 1건');
select test.expect_error($$update pii.lead_amendments set payload_enc = 'v1:changed'$$, '42501', 'AM15 변경 요청 수정 불가(추가 전용)');
select test.expect_error($$truncate pii.lead_amendments$$, '42501', 'AM15b 비우기 불가');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'application.amend' and detail = '{"answered": 7, "missing": 0}'::jsonb$$, '2', 'AM16 변경 요청 감사 기록: 개수만(본문·주소 원문 없음)');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'application.amend' and (detail::text like '%v1:%' or detail::text like '%addr%' or detail::text ~ '[0-9a-f]{64}')$$, '0', 'AM16b 감사에 암호문·해시·원문 없음');
-- 열람: 대표만, 방금 신청서를 열람한 경우만
set role app_staff;
select test.expect_error_msg(test.amd_list('owner', :'mlead'), '22023', 'PACKET_NOT_VIEWED', 'AM17 신청서 열람(감사) 없이 변경 요청 열람 불가');
select test.expect_eq(test.dcount('owner', 'dealer_packet_get', format('%L, %L', :'mlead', 'content_check')), '1', 'AM18a 대표 신청서 열람(감사·viewed)');
select test.expect_eq(test.amd_list('owner', :'mlead'), '2', 'AM18 열람 직후 대표는 변경 요청 2건 조회');
select test.expect_error(test.amd_list('reviewer', :'mlead'), '42501', 'AM19 검토자 열람 불가');
select test.expect_error(test.amd_list('editor', :'mlead'), '42501', 'AM19b 정책 담당 열람 불가');
select test.expect_error(test.amd_list('counselor', :'mlead'), '42501', 'AM19c 상담원 열람 불가');
reset role;
set role app_public;
select test.expect_error(format('select * from api.application_amendments(null, null, null, %L)', :'mlead'), '42501', 'AM19d 공개 역할 열람 함수 실행 불가');
reset role;
-- 파기: 변경 요청도 고객과 함께 삭제
set role app_staff;
select test.expect_ok(test.adcall('owner', 'purge_customer', format('%L, %L', :'mlead', '파기 시험 요청')), 'AM20 고객 파기');
reset role;
select test.expect_eq(format($$select count(*)::text from pii.lead_amendments where lead_id = %L$$, :'mlead'), '0', 'AM21 파기 시 변경 요청도 삭제');
