-- 총판 전달용 신청서(0017): 서명 없는 저장 거부·암호화 본문·열람 권한·전달 이력 추가 전용·파기 연쇄. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
create function test.dcount(p_who text, p_fn text, p_args text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'editor' then '00000000-0000-4000-8000-000000000006'
                       when 'reviewer' then '00000000-0000-4000-8000-000000000005' else '00000000-0000-4000-8000-000000000004' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'editor' then '10000000-0000-4000-8000-000000000008'
                       when 'reviewer' then '10000000-0000-4000-8000-000000000005' else '10000000-0000-4000-8000-000000000004' end;
begin
  return format('select count(*)::text from api.%s(%L, %L, %L, %s)', p_fn, a, s, test.staff_token(a, s), p_args);
end $$;
create function test.app_sql(p_idem text, p_payload text, p_summary text, p_tamper_summary text default null) returns text language plpgsql as $$
declare tok text := test.token('lead', array['application', p_idem, p_payload, p_summary]);
begin
  return format('select api.application_save(%L, %L, %L, %L)', tok, p_idem, p_payload, coalesce(p_tamper_summary, p_summary));
end $$;
-- 시험용 리드 2건(정상 접수 경로로 생성)
select set_config('t.a1', test.lead_sql(repeat('c3', 32), 'app-test-0000000001'), false);
select set_config('t.a2', test.lead_sql(repeat('d4', 32), 'app-test-0000000002'), false);
update core.feature_flags set enabled = true where key = 'lead_form';
set role app_public;
select test.expect_eq(current_setting('t.a1'), 'accepted', 'AP0 시험 리드 1');
select test.expect_eq(current_setting('t.a2'), 'accepted', 'AP0b 시험 리드 2');
reset role;
select l.id::text as lead1 from core.leads l where l.idempotency_key = 'app-test-0000000001' \gset
select l.id::text as lead2 from core.leads l where l.idempotency_key = 'app-test-0000000002' \gset
reset role;
select set_config('t.s1', test.app_sql('app-test-0000000001', 'v1:enc-app', '{"answered":6,"missing":["tvCount"],"housingType":"apartment"}'), false);
select set_config('t.s2', test.app_sql('app-test-0000000001', 'v1:enc-app', '{"answered":6,"missing":[]}'), false);
select set_config('t.s3', test.app_sql('app-test-0000000002', 'v1:enc-app2', '{"answered":1,"missing":[]}', '{"answered":9,"missing":[]}'), false);
select set_config('t.s5', test.app_sql('app-test-nolead-000000', 'v1:enc-app', '{"answered":1,"missing":[]}'), false);
select set_config('t.s6', test.app_sql('app-test-0000000002', 'plain-text-not-encrypted', '{"answered":1,"missing":[]}'), false);
select set_config('t.s7', test.app_sql('app-test-0000000002', 'v1:x', 'not json'), false);
select set_config('t.s10', test.app_sql('app-test-0000000002', 'v1:enc-app2', '{"answered":2,"missing":["housingType"]}'), false);
set role app_public;
select test.expect_eq(current_setting('t.s1'), 'saved', 'AP1 서명된 신청서 저장');
select test.expect_eq(current_setting('t.s2'), 'exists', 'AP2 같은 리드 재저장은 덮어쓰지 않음(exists)');
select test.expect_error(current_setting('t.s3'), '42501', 'AP3 서명 후 요약 변조 거부');
select test.expect_error($$select api.application_save(null, 'app-test-0000000002', 'v1:x', '{}')$$, '42501', 'AP4 서명 없는 직접 호출 거부');
select test.expect_eq(current_setting('t.s5'), 'skipped', 'AP5 리드가 없는 요청은 저장하지 않음(skipped)');
select test.expect_error(current_setting('t.s6'), '22023', 'AP6 암호문 형식이 아니면 거부(평문 저장 불가)');
select test.expect_error(current_setting('t.s7'), '22023', 'AP7 요약이 JSON 객체가 아니면 거부');
select test.expect_error($$select * from pii.lead_applications$$, '42501', 'AP8 공개 역할은 신청서 테이블을 읽을 수 없음');
select test.expect_error(format('select * from api.dealer_packet_get(null, null, null, %L, %L)', :'lead1', '사유'), '42501', 'AP9 공개 역할은 열람 함수 실행 불가');
select test.expect_eq(current_setting('t.s10'), 'saved', 'AP10 두 번째 리드 저장');
reset role;
select test.expect_eq($$select count(*)::text from pii.lead_applications where payload_enc like 'v1:%'$$, '2', 'AP11 본문은 암호문 형식으로만 저장');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'application.save' and detail::text not like '%시험로%'$$, '2', 'AP12 저장 감사 기록(원문 없음)');
-- 열람 권한
set role app_staff;
select test.expect_eq(test.dcount('owner', 'dealer_packet_get', format('%L, %L', :'lead1', '총판 전달 준비')), '1', 'PK1 대표 열람(사유 필수)');
select test.expect_error(test.dcount('owner', 'dealer_packet_get', format('%L, %L', :'lead1', ' ')), '22023', 'PK2 사유 없으면 거부');
select test.expect_error(test.dcount('editor', 'dealer_packet_get', format('%L, %L', :'lead1', '시도')), '42501', 'PK3 정책 담당 열람 불가');
select test.expect_error(test.dcount('reviewer', 'dealer_packet_get', format('%L, %L', :'lead1', '시도')), '42501', 'PK3b 검토자 열람 불가(암호문 접근 없음)');
select test.expect_error(test.dcount('counselor', 'dealer_packet_get', format('%L, %L', :'lead1', '미배정 시도')), '42501', 'PK4 배정되지 않은 상담원 열람 불가');
select test.expect_ok(test.adcall('owner', 'assign_lead', format('%L, %L', :'lead1', '00000000-0000-4000-8000-000000000004')), 'PK5a 대표가 상담원에게 배정');
select test.expect_eq(test.dcount('counselor', 'dealer_packet_get', format('%L, %L', :'lead1', '배정 건 준비')), '1', 'PK5 배정된 상담원은 열람 가능');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'pii.reveal' and detail ->> 'via' = 'dealer_packet'$$, '2', 'PK6 열람마다 감사 기록(기존 연락처 열람과 같은 action)');
select test.expect_eq($$select count(*)::text from core.dealer_handoffs where event = 'viewed'$$, '2', 'PK7 열람이 전달 이력(viewed)에 남음');
-- 전달 이력
set role app_staff;
select test.expect_ok(test.adcall('owner', 'handoff_record', format('%L, %L, null', :'lead1', 'copied')), 'HO1 복사 기록');
select test.expect_error(test.adcall('reviewer', 'handoff_record', format('%L, %L, null', :'lead1', 'copied')), '42501', 'HO2 검토자 기록 불가');
select test.expect_error(test.adcall('editor', 'handoff_record', format('%L, %L, null', :'lead1', 'copied')), '42501', 'HO2b 정책 담당 기록 불가');
select test.expect_error(test.adcall('owner', 'handoff_record', format('%L, %L, null', :'lead1', 'deleted')), '22023', 'HO3 알 수 없는 이벤트 거부');
select test.expect_error(test.adcall('owner', 'handoff_record', format('%L, %L, null', :'lead1', 'sent')), '22023', 'HO4 전달 완료는 메모(총판명 등) 필수');
select test.expect_error_msg(test.adcall('owner', 'handoff_record', format('%L, %L, %L', :'lead2', 'sent', '가상총판 전화 전달')), '22023', 'PACKET_NOT_VIEWED', 'HO5 열람하지 않은 건은 전달 완료 기록 불가');
select test.expect_ok(test.adcall('owner', 'handoff_record', format('%L, %L, %L', :'lead1', 'sent', '가상총판 담당자에게 복사 전달')), 'HO6 전달 완료 기록');
select test.expect_eq(test.dcount('owner', 'handoff_list', format('%L', :'lead1')), '4', 'HO7 대표 이력 조회(열람 2·복사·전달 완료)');
select test.expect_eq(test.dcount('reviewer', 'handoff_list', format('%L', :'lead1')), '4', 'HO7b 검토자는 이력만 조회 가능');
select test.expect_error(test.dcount('editor', 'handoff_list', format('%L', :'lead1')), '42501', 'HO7c 정책 담당 조회 불가');
reset role;
select test.expect_error($$update core.dealer_handoffs set note = 'x'$$, '42501', 'HO8 이력 수정 불가');
select test.expect_error($$delete from core.dealer_handoffs$$, '42501', 'HO8b 삭제 불가');
select test.expect_error($$truncate core.dealer_handoffs$$, '42501', 'HO8c 비우기 불가');
select test.expect_eq($$select count(*)::text from core.audit_logs where action in ('handoff.copied', 'handoff.sent')$$, '2', 'HO9 복사·전달 완료 감사 기록');
-- 파기: 암호화 신청서는 고객과 함께 삭제, 이력은 개인정보 없이 남고 열람은 막힘
set role app_staff;
select test.expect_ok(test.adcall('owner', 'purge_customer', format('%L, %L', :'lead1', '파기 시험 요청')), 'PG1 고객 파기');
reset role;
select test.expect_eq(format($$select count(*)::text from pii.lead_applications where lead_id = %L$$, :'lead1'), '0', 'PG2 파기 시 암호화 신청서도 삭제');
select test.expect_eq(format($$select count(*)::text from core.dealer_handoffs where lead_id = %L$$, :'lead1'), '4', 'PG3 전달 이력은 개인정보가 없어 남음');
set role app_staff;
select test.expect_error(test.dcount('owner', 'dealer_packet_get', format('%L, %L', :'lead1', '파기 뒤 시도')), '42501', 'PG4 파기된 고객은 열람 불가');
reset role;
