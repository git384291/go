-- 설치·정산·환수(0069, PM 11/27 CRM ⑤): 전환 리드만, 상태 순서, 환수 위험 판정, 정산 추가 전용, 대표만, 공개 역할 차단, 감사. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
create function test.ct(p_who text, p_sql text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' else '00000000-0000-4000-8000-000000000002' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' else '10000000-0000-4000-8000-000000000002' end;
begin
  return replace(replace(replace(p_sql, '$A', quote_literal(a)), '$S', quote_literal(s)), '$T', quote_literal(test.staff_token(a, s)));
end $$;
update core.feature_flags set enabled = true where key = 'lead_form';
select set_config('t.c1', test.lead_sql(repeat('3c', 32), 'ct-test-0000000001', p_ip => repeat('3', 64)), false);
select set_config('t.c2', test.lead_sql(repeat('3d', 32), 'ct-test-0000000002', p_ip => repeat('3', 64)), false);
set role app_public;
select test.expect_eq(current_setting('t.c1'), 'accepted', 'CT0a 접수 1');
select test.expect_eq(current_setting('t.c2'), 'accepted', 'CT0b 접수 2');
reset role;
select l.id::text as c1 from core.leads l where l.idempotency_key = 'ct-test-0000000001' \gset
select l.id::text as c2 from core.leads l where l.idempotency_key = 'ct-test-0000000002' \gset
select (now() at time zone 'Asia/Seoul')::date::text as today \gset
set role app_staff;
-- 미전환 리드는 설치 일정 불가
select test.expect_error_msg(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'KT', %L::date + 3, 36, 12)$$, :'c1', :'today')), '22023', 'LEAD_NOT_CONVERTED', 'CT1 전환 전 리드 설치 일정 거부');
reset role;
update core.leads set status = 'converted', updated_at = now() where id in (:'c1', :'c2');
set role app_staff;
select test.expect_error(test.ct('counselor', format($$select api.contract_schedule($A, $S, $T, %L, 'KT', %L::date + 3, 36, 12)$$, :'c1', :'today')), '42501', 'CT2 대표 외 직원 일정 등록 불가');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'XX', %L::date + 3, 36, 12)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT3 통신사 형식 오류 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'KT', %L::date + 3, 12, 24)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT4 환수 기간 > 약정 기간 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'KT', %L::date + 91, 36, 12)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT5 90일 넘는 설치 예정일 거부');
select test.expect_eq(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'KT', %L::date - 20, 36, 12)$$, :'c1', :'today')), 'scheduled', 'CT6 리드1 KT 설치 일정 등록');
select test.expect_eq(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'SKB', %L::date - 20, 36, 12)$$, :'c1', :'today')), 'updated', 'CT7 설치 전 일정 변경');
select test.expect_eq(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'LGU', %L::date + 5, 36, 12)$$, :'c2', :'today')), 'scheduled', 'CT8 리드2 일정 등록');
-- 정산은 설치 전 불가
select test.expect_error_msg(test.ct('owner', format($$select api.settlement_record($A, $S, $T, %L, 'received', 300000, %L::date)$$, :'c1', :'today')), '22023', 'CONTRACT_TRANSITION', 'CT9 설치 전 정산 기록 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'terminated', %L::date)$$, :'c1', :'today')), '22023', 'CONTRACT_TRANSITION', 'CT10 설치 전 해지 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'installed', %L::date + 1)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT11 미래 설치일 거부');
select test.expect_eq(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'installed', %L::date - 10)$$, :'c1', :'today')), 'installed', 'CT12 리드1 설치 완료');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_schedule($A, $S, $T, %L, 'KT', %L::date, 36, 12)$$, :'c1', :'today')), '22023', 'CONTRACT_TRANSITION', 'CT13 설치 뒤 일정 변경 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'installed', %L::date)$$, :'c1', :'today')), '22023', 'CONTRACT_TRANSITION', 'CT14 두 번 설치 완료 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.settlement_record($A, $S, $T, %L, 'received', 300000, %L::date - 11)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT15a 지급일이 설치일보다 빠르면 거부(날짜 역전)');
select test.expect_ok(test.ct('owner', format($$select api.settlement_record($A, $S, $T, %L, 'received', 300000, %L::date)$$, :'c1', :'today')), 'CT15 총판 지급 받음 기록');
select test.expect_error_msg(test.ct('owner', format($$select api.settlement_record($A, $S, $T, %L, 'clawback', 300000, %L::date)$$, :'c1', :'today')), '22023', 'CONTRACT_TRANSITION', 'CT16 해지 전 환수 기록 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.settlement_record($A, $S, $T, %L, 'received', 0, %L::date)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT17 0원 거부');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'terminated', %L::date - 11)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT18 설치일보다 이른 해지일 거부');
-- 환수 기간(12개월) 안 해지 → 위험
select test.expect_eq(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'terminated', %L::date)$$, :'c1', :'today')), 'clawback_risk', 'CT19 환수 기간 안 해지 = 환수 위험');
select test.expect_eq(test.ct('owner', $$select count(*)::text from api.contract_list($A, $S, $T, 'clawback_risk')$$), '1', 'CT20 환수 위험 목록 1건');
select test.expect_error_msg(test.ct('owner', format($$select api.settlement_record($A, $S, $T, %L, 'clawback', 300000, %L::date - 1)$$, :'c1', :'today')), '22023', 'INVALID_INPUT', 'CT21a 환수일이 해지일보다 빠르면 거부(날짜 역전)');
select test.expect_ok(test.ct('owner', format($$select api.settlement_record($A, $S, $T, %L, 'clawback', 300000, %L::date)$$, :'c1', :'today')), 'CT21 환수 기록');
select test.expect_eq(test.ct('owner', $$select count(*)::text from api.contract_list($A, $S, $T, 'clawback_risk')$$), '0', 'CT22 환수 기록 뒤 위험 해소');
select test.expect_eq(test.ct('owner', format($$select received_krw || '/' || clawback_krw || '/' || status from api.contract_list($A, $S, $T, 'all') where lead_id = %L$$, :'c1')), '300000/300000/terminated', 'CT23 목록 합계·상태');
-- 설치 전 취소
select test.expect_error_msg(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'cancelled', %L::date)$$, :'c2', :'today')), '22023', 'INVALID_INPUT', 'CT24 취소에 날짜 넣으면 거부');
select test.expect_eq(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'cancelled', null)$$, :'c2')), 'cancelled', 'CT25 설치 전 취소');
select test.expect_error_msg(test.ct('owner', format($$select api.contract_status($A, $S, $T, %L, 'installed', %L::date)$$, :'c2', :'today')), '22023', 'CONTRACT_TRANSITION', 'CT26 취소 뒤 설치 거부');
select test.expect_error(test.ct('counselor', $$select count(*)::text from api.contract_list($A, $S, $T, 'all')$$), '42501', 'CT27 대표 외 직원 목록(금액) 열람 불가');
select test.expect_error_msg(test.ct('owner', $$select count(*)::text from api.contract_list($A, $S, $T, 'x')$$), '22023', 'INVALID_INPUT', 'CT28 필터 형식 오류 거부');
select test.expect_error($$select * from core.lead_contracts$$, '42501', 'CT29 직원 역할도 표 직접 접근 불가');
reset role;
set role app_public;
select test.expect_error($$select * from core.settlements$$, '42501', 'CT30 공개 역할 정산 표 접근 불가');
select test.expect_error($$select * from api.contract_list(null, null, null, 'all')$$, '42501', 'CT31 공개 역할 목록 함수 실행 불가');
reset role;
-- 원장 추가 전용·상태 되돌리기 불가(관리 역할로도)
select test.expect_error($$update core.settlements set amount_krw = 1$$, '42501', 'CT32 정산 금액 수정 불가');
select test.expect_error($$delete from core.settlements$$, '42501', 'CT33 정산 삭제 불가');
select test.expect_error($$truncate core.settlements$$, '42501', 'CT34 정산 비우기 불가');
select test.expect_error(format($$update core.lead_contracts set status = 'installed' where lead_id = %L$$, :'c1'), '42501', 'CT35 해지 → 설치로 되돌리기 불가');
select test.expect_error($$delete from core.lead_contracts$$, '42501', 'CT36 계약 삭제 불가');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'contract.%' or action like 'settlement.%'$$, '8', 'CT37 쓰기 8건 모두 감사 기록');
select test.expect_eq($$select count(*)::text from core.audit_logs where (action like 'contract.%' or action like 'settlement.%') and detail::text ~ '[0-9a-f]{64}|300000'$$, '0', 'CT38 감사에 연락처 해시·금액 없음');
select test.expect_eq($$select count(*)::text from core.settlements$$, '2', 'CT39 거부된 역전 건은 원장에 남지 않음(지급 1·환수 1만)');
