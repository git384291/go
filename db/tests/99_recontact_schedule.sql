-- 날짜별 재연락 일정·수신 거부(0060, PM 11/25 ③): 같은 날 중복 금지, 수신 거부·동의 없음 차단, 대표만, 추가 전용, 감사에 원문 없음. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
create function test.rc_staff(p_who text, p_fn text, p_a text default null, p_b text default null, p_c text default null) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' else '00000000-0000-4000-8000-000000000006' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' else '10000000-0000-4000-8000-000000000008' end;
  t text := test.staff_token(a, s);
  kst date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_fn = 'sched' then   -- p_a = lead id, p_b = 오늘로부터 일수, p_c = 채널
    return format('select api.recontact_schedule(%L, %L, %L, %L, %L::date, %L)', a, s, t, p_a, kst + p_b::int, p_c);
  elsif p_fn = 'due' then return format('select count(*)::text from api.recontact_due(%L, %L, %L)', a, s, t);
  elsif p_fn = 'sweep' then return format('select api.recontact_sweep(%L, %L, %L)::text', a, s, t);
  end if;
  return format('select api.recontact_close(%L, %L, %L, %L::bigint, %L)', a, s, t, p_a, p_b);   -- close: p_a = 일정 id, p_b = 상태
end $$;
create function test.rc_optout(p_hmac text, p_ch text, p_tamper text default null) returns text language plpgsql as $$
begin
  return format('select api.marketing_opt_out(%L, %L, %L)', test.token('lead', array['optout', p_hmac, p_ch]), coalesce(p_tamper, p_hmac), p_ch);
end $$;
update core.feature_flags set enabled = true where key = 'lead_form';
select set_config('t.l_a', test.lead_sql(repeat('a1', 32), 'rc-test-0000000001', p_ip => repeat('b', 64)), false);
select set_config('t.l_b', test.lead_sql(repeat('b1', 32), 'rc-test-0000000002', p_ip => repeat('b', 64)), false);
select set_config('t.l_c', test.lead_sql(repeat('c1', 32), 'rc-test-0000000003', p_ip => repeat('b', 64)), false);
select set_config('t.l_d', test.lead_sql(repeat('d1', 32), 'rc-test-0000000004', p_ip => repeat('b', 64)), false);
select set_config('t.fu_b', format('select api.followup_request(%L, %L, %L, %L)', test.token('lead', array['followup', 'rc-fu-0000000001', repeat('b1', 32), 'privacy-test-v1']), 'rc-fu-0000000001', repeat('b1', 32), 'privacy-test-v1'), false);
select set_config('t.o_b', test.rc_optout(repeat('b1', 32), 'phone'), false);
select set_config('t.o_none', test.rc_optout(repeat('9f', 32), 'all'), false);
select set_config('t.o_tamper', test.rc_optout(repeat('b1', 32), 'phone', p_tamper => repeat('c1', 32)), false);
select set_config('t.o_badhmac', format('select api.marketing_opt_out(%L, %L, %L)', test.token('lead', array['optout', 'bad', 'sms']), 'bad', 'sms'), false);
set role app_public;
select test.expect_eq(current_setting('t.l_a'), 'accepted', 'RC0a 접수 A');
select test.expect_eq(current_setting('t.l_b'), 'accepted', 'RC0b 접수 B');
select test.expect_eq(current_setting('t.l_c'), 'accepted', 'RC0c 접수 C');
select test.expect_eq(current_setting('t.l_d'), 'accepted', 'RC0d 접수 D');
select test.expect_eq(current_setting('t.fu_b'), 'requested', 'RC0e B 전화 직접 연락 동의');
reset role;
-- 가상 수신 동의(문자): A·D
insert into pii.marketing_consents (customer_id, event, channel, doc_version, created_at)
select l.customer_id, 'opt_in', 'sms', 'privacy-test-v1', now() - interval '1 hour' from core.leads l where l.idempotency_key in ('rc-test-0000000001', 'rc-test-0000000004');
select l.id::text as la from core.leads l where l.idempotency_key = 'rc-test-0000000001' \gset
select l.id::text as lb from core.leads l where l.idempotency_key = 'rc-test-0000000002' \gset
select l.id::text as lc from core.leads l where l.idempotency_key = 'rc-test-0000000003' \gset
select l.id::text as ld from core.leads l where l.idempotency_key = 'rc-test-0000000004' \gset
set role app_staff;
select test.expect_eq(test.rc_staff('owner', 'sched', :'la', '1', 'sms'), 'scheduled', 'RC1 A 문자 재연락 내일 예약');
select test.expect_eq(test.rc_staff('owner', 'sched', :'la', '1', 'sms'), 'exists', 'RC2 같은 리드 같은 날 중복 예약은 exists');
select test.expect_error_msg(test.rc_staff('owner', 'sched', :'la', '2', 'phone'), '22023', 'NO_CONSENT', 'RC3 문자 동의만 있고 전화 동의 없음: 전화 예약 거부');
select test.expect_eq(test.rc_staff('owner', 'sched', :'lb', '0', 'phone'), 'scheduled', 'RC4 B 전화(직접 연락 동의) 오늘 예약');
select test.expect_error_msg(test.rc_staff('owner', 'sched', :'lc', '1', 'sms'), '22023', 'NO_CONSENT', 'RC5 동의 없는 C 예약 거부');
select test.expect_error_msg(test.rc_staff('owner', 'sched', :'la', '-1', 'sms'), '22023', 'INVALID_INPUT', 'RC6 과거 날짜 거부');
select test.expect_error_msg(test.rc_staff('owner', 'sched', :'la', '91', 'sms'), '22023', 'INVALID_INPUT', 'RC7 90일 초과 거부');
select test.expect_error_msg(test.rc_staff('owner', 'sched', :'la', '2', 'fax'), '22023', 'INVALID_INPUT', 'RC8 채널 형식 오류 거부');
select test.expect_error(test.rc_staff('editor', 'sched', :'la', '3', 'sms'), '42501', 'RC9 대표 외 직원 예약 불가');
select test.expect_error(test.rc_staff('editor', 'due'), '42501', 'RC10 대표 외 직원 목록 불가');
select test.expect_eq(test.rc_staff('owner', 'due'), '1', 'RC11 오늘 처리할 건: B 1건(A는 내일)');
reset role;
select test.expect_eq($$select count(*)::text from core.recontact_schedule where status = 'pending'$$, '2', 'RC12 대기 2건(A 내일·B 오늘)');
-- 수신 거부
set role app_public;
select test.expect_eq(current_setting('t.o_b'), 'recorded', 'RC13 B 전화 수신 거부 기록');
select test.expect_eq(current_setting('t.o_none'), 'recorded', 'RC14 없는 연락처도 같은 응답(존재 여부 비노출)');
select test.expect_error(current_setting('t.o_tamper'), '42501', 'RC15 서명 후 연락처 변조 거부');
select test.expect_error(current_setting('t.o_badhmac'), '22023', 'RC16 연락처 해시 형식 오류 거부');
select test.expect_error($$select api.marketing_opt_out(null, repeat('b1', 32), 'sms')$$, '42501', 'RC17 서명 없는 직접 호출 거부');
select test.expect_error($$select * from core.recontact_schedule$$, '42501', 'RC18 공개 역할은 일정 테이블을 읽을 수 없음');
select test.expect_error($$select * from api.recontact_due(null, null, null)$$, '42501', 'RC19 공개 역할은 목록 함수 실행 불가');
reset role;
select test.expect_eq(format($$select status from core.recontact_schedule where lead_id = %L$$, :'lb'), 'blocked', 'RC20 수신 거부 즉시 B의 대기 건 차단');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'marketing.opt_out'$$, '1', 'RC21 감사 1건(없는 연락처는 기록 없음)');
set role app_staff;
select test.expect_eq(test.rc_staff('owner', 'due'), '0', 'RC22 차단 뒤 오늘 목록 0건');
select test.expect_error_msg(test.rc_staff('owner', 'sched', :'lb', '1', 'phone'), '22023', 'OPTED_OUT', 'RC23 수신 거부 뒤 재예약 거부');
reset role;
-- 처리 완료·취소
select s.id::text as sa from core.recontact_schedule s where s.lead_id = :'la' and s.status = 'pending' \gset
set role app_staff;
select test.expect_error(test.rc_staff('editor', 'close', :'sa', 'done'), '42501', 'RC24 대표 외 직원 완료 불가');
select test.expect_error_msg(test.rc_staff('owner', 'close', :'sa', 'blocked'), '22023', 'INVALID_INPUT', 'RC25 완료·취소 외 상태 거부');
select test.expect_ok(test.rc_staff('owner', 'close', :'sa', 'done'), 'RC26 대표 완료 처리');
select test.expect_error_msg(test.rc_staff('owner', 'close', :'sa', 'done'), '22023', 'NOT_PENDING', 'RC27 이미 처리된 건 재처리 거부');
-- 동의 철회 뒤 sweep
select test.expect_eq(test.rc_staff('owner', 'sched', :'la', '2', 'sms'), 'scheduled', 'RC28 A 문자 모레 예약');
reset role;
insert into pii.marketing_consents (customer_id, event, channel, created_at)
select l.customer_id, 'opt_out', 'sms', now() from core.leads l where l.id = :'la';
set role app_staff;
select test.expect_eq(test.rc_staff('owner', 'sweep'), '1', 'RC29 철회된 대기 1건 sweep 차단');
select test.expect_eq(test.rc_staff('owner', 'sweep'), '0', 'RC30 재실행은 0건');
-- 리드당 대기 3건 제한
select test.expect_eq(test.rc_staff('owner', 'sched', :'ld', '1', 'sms'), 'scheduled', 'RC31 D 1일 뒤');
select test.expect_eq(test.rc_staff('owner', 'sched', :'ld', '2', 'sms'), 'scheduled', 'RC32 D 2일 뒤');
select test.expect_eq(test.rc_staff('owner', 'sched', :'ld', '3', 'sms'), 'scheduled', 'RC33 D 3일 뒤');
select test.expect_error_msg(test.rc_staff('owner', 'sched', :'ld', '4', 'sms'), '22023', 'TOO_MANY_PENDING', 'RC34 리드당 대기 3건 초과 거부');
reset role;
select test.expect_error($$update core.recontact_schedule set status = 'pending', closed_at = null where status = 'done'$$, '42501', 'RC35 처리된 건 되돌리기 불가');
select test.expect_error($$update core.recontact_schedule set due_on = due_on + 1 where status = 'pending'$$, '42501', 'RC36 예정일 직접 수정 불가(취소 후 재예약만)');
select test.expect_error($$delete from core.recontact_schedule$$, '42501', 'RC37 삭제 불가');
select test.expect_error($$truncate core.recontact_schedule$$, '42501', 'RC38 비우기 불가');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'recontact.%' and (detail::text ~ '[0-9a-f]{64}' or detail::text like '%enc%' or detail::text like '%평일%')$$, '0', 'RC39 감사에 연락처·원문 없음');
