-- 고객·접수·CRM 통합(0051, PM 11/25 ①③): 기간 밖 재신청도 고객 1명, 같은 사람 같은 날 재연락 중복 금지, 통합 이력·미처리 분류(대표만, 가린 값만). 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
create function test.cu_staff(p_who text, p_fn text, p_lead text default null) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' else '00000000-0000-4000-8000-000000000006' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' else '10000000-0000-4000-8000-000000000008' end;
  t text := test.staff_token(a, s);
begin
  if p_fn = 'tl' then return format('select count(*)::text from api.customer_timeline(%L, %L, %L, %L)', a, s, t, p_lead);
  elsif p_fn = 'tl_leads' then return format('select count(*)::text from api.customer_timeline(%L, %L, %L, %L) where kind = ''lead''', a, s, t, p_lead);
  elsif p_fn = 'tl_text' then return format('select (coalesce(string_agg(detail::text, ''|''), '''') ~ ''[0-9a-f]{64}|v1:|enc-'')::text from api.customer_timeline(%L, %L, %L, %L)', a, s, t, p_lead);
  end if;
  return format('select coalesce(string_agg(reason, '','' order by reason), '''') from api.crm_unhandled(%L, %L, %L) where lead_id = %L', a, s, t, p_lead);
end $$;
update core.feature_flags set enabled = true where key = 'lead_form';
select set_config('t.x1', test.lead_sql(repeat('e1', 32), 'cu-test-0000000001', p_ip => repeat('c', 64)), false);
select set_config('t.x2', test.lead_sql(repeat('e1', 32), 'cu-test-0000000002', p_ip => repeat('c', 64)), false);
select set_config('t.x3', test.lead_sql(repeat('e1', 32), 'cu-test-0000000003', p_ip => repeat('c', 64)), false);
select set_config('t.y1', test.lead_sql(repeat('f7', 32), 'cu-test-0000000004', p_ip => repeat('c', 64)), false);
select set_config('t.g1', test.lead_sql(repeat('d7', 32), 'cu-test-0000000005', p_ip => repeat('c', 64)), false);
set role app_public;
select test.expect_eq(current_setting('t.x1'), 'accepted', 'CU0a 첫 신청');
reset role;
-- 중복 판정 기간(7일) 밖으로 이동
update core.leads set created_at = now() - interval '10 days' where idempotency_key = 'cu-test-0000000001';
update pii.customers set retention_until = now() + interval '1 day' where phone_hmac = repeat('e1', 32);
set role app_public;
select test.expect_eq(current_setting('t.x2'), 'accepted', 'CU0b 10일 뒤 같은 번호 재신청');
select test.expect_eq(current_setting('t.x3'), 'accepted', 'CU0c 기간 안 재문의');
select test.expect_eq(current_setting('t.y1'), 'accepted', 'CU0d 다른 번호');
select test.expect_eq(current_setting('t.g1'), 'accepted', 'CU0e 미처리용 번호');
reset role;
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac = repeat('e1', 32)$$, '1', 'CU1 기간 밖 재신청도 고객 1명(중복 생성 금지)');
select test.expect_eq($$select count(*)::text from core.leads where idempotency_key like 'cu-test-000000000%' and idempotency_key <= 'cu-test-0000000003'$$, '2', 'CU2 리드는 2건(기간 안 재문의는 이력만)');
select test.expect_eq($$select count(distinct customer_id)::text from core.leads where idempotency_key in ('cu-test-0000000001', 'cu-test-0000000002')$$, '1', 'CU3 두 리드가 같은 고객');
select test.expect_eq($$select (retention_until > now() + interval '30 days')::text from pii.customers where phone_hmac = repeat('e1', 32)$$, 'true', 'CU4 재신청 시 보유기간 연장');
select test.expect_eq($$select (name_enc = 'v1:enc-name')::text from pii.customers where phone_hmac = repeat('e1', 32)$$, 'true', 'CU5 기존 암호문 유지(덮어쓰기 없음)');
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac in (repeat('f7', 32), repeat('d7', 32))$$, '2', 'CU6 다른 번호는 다른 고객');
select l.id::text as x1 from core.leads l where l.idempotency_key = 'cu-test-0000000001' \gset
select l.id::text as x2 from core.leads l where l.idempotency_key = 'cu-test-0000000002' \gset
select l.id::text as y1 from core.leads l where l.idempotency_key = 'cu-test-0000000004' \gset
select l.id::text as g1 from core.leads l where l.idempotency_key = 'cu-test-0000000005' \gset
insert into pii.marketing_consents (customer_id, event, channel, doc_version, created_at)
select c.id, 'opt_in', 'sms', 'privacy-test-v1', now() - interval '1 hour' from pii.customers c where c.phone_hmac in (repeat('e1', 32), repeat('f7', 32));
-- 같은 사람의 다른 리드에 같은 날 재연락 금지
set role app_staff;
select test.expect_eq(test.rc_staff('owner', 'sched', :'x1', '1', 'sms'), 'scheduled', 'CU7 리드1 내일 예약');
select test.expect_eq(test.rc_staff('owner', 'sched', :'x2', '1', 'sms'), 'exists', 'CU8 같은 사람 리드2 같은 날 → exists(중복 연락 금지)');
select test.expect_eq(test.rc_staff('owner', 'sched', :'x2', '2', 'sms'), 'scheduled', 'CU9 다른 날은 예약');
-- 통합 이력
select test.expect_eq(test.cu_staff('owner', 'tl_leads', :'x2'), '2', 'CU10 통합 이력: 같은 사람 리드 2건');
select test.expect_error(test.cu_staff('editor', 'tl', :'x2'), '42501', 'CU11 대표 외 직원 통합 이력 불가');
select test.expect_error(test.cu_staff('owner', 'tl', gen_random_uuid()::text), '42501', 'CU12 없는 리드 → FORBIDDEN');
select test.expect_eq(test.cu_staff('owner', 'tl_text', :'x2'), 'false', 'CU13 이력에 HMAC·암호문 없음');
reset role;
select test.expect_eq($$select (count(*) >= 2)::text from core.audit_logs where action = 'crm.timeline'$$, 'true', 'CU14 통합 이력 열람 감사 기록');
-- 미처리 자동 분류
update core.leads set created_at = now() - interval '2 days' where id = :'g1';
set role app_staff;
select test.expect_eq(test.cu_staff('owner', 'un', :'g1'), 'NEW_UNTOUCHED', 'CU15 24시간 넘은 신규 = 미처리');
select test.expect_eq(test.cu_staff('owner', 'un', :'x1'), '', 'CU16 재연락 예약된 신규는 미처리 아님');
reset role;
insert into core.recontact_schedule (lead_id, due_on, channel, created_by)
values (:'y1', (now() at time zone 'Asia/Seoul')::date - 1, 'sms', '00000000-0000-4000-8000-000000000001');
insert into core.lead_followups (lead_id, event, idempotency_key, privacy_version) values (:'g1', 'requested', 'cu-fu-0000000001', 'privacy-test-v1');
set role app_staff;
select test.expect_eq(test.cu_staff('owner', 'un', :'y1'), 'RECONTACT_OVERDUE', 'CU17 지난 재연락 = 미처리');
select test.expect_eq(test.cu_staff('owner', 'un', :'g1'), 'FOLLOWUP_OPEN,NEW_UNTOUCHED', 'CU18 후속 연락 미완료 분류');
reset role;
insert into core.lead_followups (lead_id, event, actor_id) values (:'g1', 'done', '00000000-0000-4000-8000-000000000001');
set role app_staff;
select test.expect_eq(test.cu_staff('owner', 'un', :'g1'), 'NEW_UNTOUCHED', 'CU19 후속 연락 완료 후 분류 해제');
select test.expect_error(test.cu_staff('editor', 'un', :'g1'), '42501', 'CU20 대표 외 직원 미처리 목록 불가');
reset role;
select test.expect_error($$set role app_public; select * from api.crm_unhandled(null, null, null)$$, '42501', 'CU21 공개 역할 실행 불가');
reset role;
