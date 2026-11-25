-- 파기 범위 분리(0062, PM 11/25 B): 신청 1건 파기는 다른 신청·고객정보 보존, 마지막 신청이면 고객 파기, 계약 완료는 보존(LEGAL_HOLD). 가상 데이터만. 99_crm_unify 뒤에 실행.
\set ON_ERROR_STOP 1
reset role;
create function test.ps_sql(p_who text, p_fn text, p_lead text, p_reason text default '고객 요청 파기') returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' else '00000000-0000-4000-8000-000000000006' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' else '10000000-0000-4000-8000-000000000008' end;
begin
  if p_fn = 'lead' then return format('select api.purge_lead(%L, %L, %L, %L, %L)', a, s, test.staff_token(a, s), p_lead, p_reason); end if;
  return format('select api.purge_customer(%L, %L, %L, %L, %L)::text', a, s, test.staff_token(a, s), p_lead, p_reason);
end $$;
select l.id::text as x1 from core.leads l where l.idempotency_key = 'cu-test-0000000001' \gset
select l.id::text as x2 from core.leads l where l.idempotency_key = 'cu-test-0000000002' \gset
select l.id::text as y1 from core.leads l where l.idempotency_key = 'cu-test-0000000004' \gset
insert into pii.lead_applications (customer_id, lead_id, payload_enc, summary)
select l.customer_id, l.id, 'v1:app', '{}'::jsonb from core.leads l where l.id in (:'x1', :'x2');
set role app_staff;
select test.expect_error(test.ps_sql('editor', 'lead', :'x1'), '42501', 'PS1 대표 외 직원 신청 파기 불가');
select test.expect_error_msg(test.ps_sql('owner', 'lead', :'x1', '짧음'), '22023', 'REASON_REQUIRED', 'PS2 사유 5자 미만 거부');
select test.expect_error(test.ps_sql('owner', 'lead', gen_random_uuid()::text), '42501', 'PS3 없는 신청 → FORBIDDEN');
select test.expect_eq(test.ps_sql('owner', 'lead', :'x1'), 'lead', 'PS4 신청 1건만 파기');
reset role;
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac = repeat('e1', 32)$$, '1', 'PS5 고객 정보 보존');
select test.expect_eq(format($$select (customer_id is not null and purged_at is null)::text from core.leads where id = %L$$, :'x2'), 'true', 'PS6 다른 신청 보존');
select test.expect_eq(format($$select (customer_id is null and purged_at is not null and name_masked = '파기됨')::text from core.leads where id = %L$$, :'x1'), 'true', 'PS7 파기 신청은 가림·연결 끊김');
select test.expect_eq(format($$select count(*)::text from pii.lead_applications where lead_id = %L$$, :'x1'), '0', 'PS8 파기 신청의 신청서 삭제');
select test.expect_eq(format($$select count(*)::text from pii.lead_applications where lead_id = %L$$, :'x2'), '1', 'PS9 다른 신청의 신청서 보존');
select test.expect_eq(format($$select count(*)::text from core.recontact_schedule where lead_id = %L and status = 'pending'$$, :'x1'), '0', 'PS10 파기 신청의 대기 재연락 차단');
select test.expect_eq(format($$select count(*)::text from core.recontact_schedule where lead_id = %L and status = 'pending'$$, :'x2'), '1', 'PS11 다른 신청의 재연락 유지');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'pii.purge_lead'$$, '1', 'PS12 신청 파기 감사 1건');
set role app_staff;
select test.expect_eq(test.ps_sql('owner', 'lead', :'x2'), 'customer', 'PS13 마지막 신청 파기 = 고객 파기');
reset role;
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac = repeat('e1', 32)$$, '0', 'PS14 마지막 신청 뒤 고객 암호문 0');
-- 법정 보존(계약 완료)
update core.leads set status = 'converted' where id = :'y1';
set role app_staff;
select test.expect_error_msg(test.ps_sql('owner', 'lead', :'y1'), '55000', 'LEGAL_HOLD', 'PS15 계약 완료 신청 파기 거부');
select test.expect_error_msg(test.ps_sql('owner', 'customer', :'y1'), '55000', 'LEGAL_HOLD', 'PS16 계약 완료 고객 전체 파기 거부');
reset role;
update pii.customers set retention_until = now() - interval '1 day' where phone_hmac = repeat('f7', 32);
select core.purge_expired();
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac = repeat('f7', 32)$$, '1', 'PS17 만료 자동 파기도 계약 완료 고객은 제외');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'pii.purge%' and (reason ~ '[0-9a-f]{64}' or reason like '%enc%')$$, '0', 'PS18 파기 감사에 연락처·암호문 없음');
