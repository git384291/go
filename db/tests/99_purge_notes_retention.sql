-- 파기 보완(0053, PM 11/25 A안·법정 보존 분리): 상담 메모 함께 파기, 계약 완료 5년만 보존, 보존 중에도 다른 신청은 따로 파기. 가상 데이터만. 99_purge_scope 뒤.
\set ON_ERROR_STOP 1
reset role;
select set_config('t.n1', test.lead_sql(repeat('c9', 32), 'pn-test-0000000001', p_ip => repeat('5a', 32)), false);
select set_config('t.n2', test.lead_sql(repeat('c9', 32), 'pn-test-0000000002', p_ip => repeat('5a', 32)), false);
select set_config('t.z1', test.lead_sql(repeat('b9', 32), 'pn-test-0000000003', p_ip => repeat('5a', 32)), false);
select set_config('t.w1', test.lead_sql(repeat('f7', 32), 'pn-test-0000000004', p_ip => repeat('5a', 32)), false);
set role app_public;
select test.expect_eq(current_setting('t.n1'), 'accepted', 'PN0a 신청 1');
reset role;
update core.leads set created_at = now() - interval '10 days' where idempotency_key = 'pn-test-0000000001';
update core.leads set created_at = now() - interval '10 days' where idempotency_key = 'cu-test-0000000004';
set role app_public;
select test.expect_eq(current_setting('t.n2'), 'accepted', 'PN0b 같은 번호 신청 2');
select test.expect_eq(current_setting('t.z1'), 'accepted', 'PN0c 오래된 계약 고객');
select test.expect_eq(current_setting('t.w1'), 'accepted', 'PN0d 계약 고객의 새 신청');
reset role;
select l.id::text as n1 from core.leads l where l.idempotency_key = 'pn-test-0000000001' \gset
select l.id::text as n2 from core.leads l where l.idempotency_key = 'pn-test-0000000002' \gset
select l.id::text as z1 from core.leads l where l.idempotency_key = 'pn-test-0000000003' \gset
select l.id::text as w1 from core.leads l where l.idempotency_key = 'pn-test-0000000004' \gset
select l.id::text as y1 from core.leads l where l.idempotency_key = 'cu-test-0000000004' \gset
insert into core.lead_notes (lead_id, author_id, body)
select x::uuid, '00000000-0000-4000-8000-000000000001', '메모 010-1234-5678' from unnest(array[:'n1', :'n2']) x;
set role app_staff;
select test.expect_eq(test.ps_sql('owner', 'lead', :'n1'), 'lead', 'PN1 신청 1 파기');
reset role;
select test.expect_eq(format($$select count(*)::text from core.lead_notes where lead_id = %L$$, :'n1'), '0', 'PN2 파기 신청의 상담 메모 삭제');
select test.expect_eq(format($$select count(*)::text from core.lead_notes where lead_id = %L$$, :'n2'), '1', 'PN3 다른 신청 메모 보존');
set role app_staff;
select test.expect_eq(test.ps_sql('owner', 'lead', :'n2'), 'customer', 'PN4 마지막 신청 파기 = 고객 파기');
reset role;
select test.expect_eq(format($$select count(*)::text from core.lead_notes where lead_id in (%L, %L)$$, :'n1', :'n2'), '0', 'PN5 고객 파기 시 메모 0');
-- 법정 보존 분리
select test.expect_eq(format($$select core.legal_hold(customer_id)::text from core.leads where id = %L$$, :'y1'), 'true', 'PN6 최근 계약 완료 = 보존');
select test.expect_eq(format($$select (customer_id = (select customer_id from core.leads where id = %L))::text from core.leads where id = %L$$, :'y1', :'w1'), 'true', 'PN7 계약 고객의 새 신청은 같은 고객');
set role app_staff;
select test.expect_eq(test.ps_sql('owner', 'lead', :'w1'), 'lead', 'PN8 보존 중에도 계약 아닌 신청은 따로 파기');
select test.expect_error_msg(test.ps_sql('owner', 'lead', :'y1'), '55000', 'LEGAL_HOLD', 'PN9 계약 신청은 여전히 보존');
reset role;
select test.expect_eq(format($$select (customer_id is not null and status = 'converted')::text from core.leads where id = %L$$, :'y1'), 'true', 'PN10 계약 신청·고객 정보 보존');
update core.leads set status = 'converted', updated_at = now() - interval '6 years' where id = :'z1';
insert into core.lead_status_history (lead_id, from_status, to_status, reason, at) values (:'z1', 'consulted', 'converted', 'test', now() - interval '6 years');
select test.expect_eq(format($$select core.legal_hold(customer_id)::text from core.leads where id = %L$$, :'z1'), 'false', 'PN11 계약 완료 5년 지나면 보존 해제');
update pii.customers set retention_until = now() - interval '1 day' where phone_hmac = repeat('b9', 32);
select core.purge_expired();
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac = repeat('b9', 32)$$, '0', 'PN12 보존 해제 + 보유기간 만료 → 자동 파기');
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac = repeat('f7', 32)$$, '1', 'PN13 보존 중 고객은 자동 파기 제외');
select test.expect_error($$set role app_staff; select core.legal_hold(null)$$, '42501', 'PN14 앱 역할은 보존 판정 함수 직접 실행 불가');
reset role;
