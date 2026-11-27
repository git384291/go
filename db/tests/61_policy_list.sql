-- 정책 조회 함수(0009). 0008의 정책 시험(60) 뒤에 실행한다. 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1

create function test.plist(p_who text, p_limit int, p_offset int default 0) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'editor' then '00000000-0000-4000-8000-000000000006'
                       else '00000000-0000-4000-8000-000000000002' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'editor' then '10000000-0000-4000-8000-000000000008'
                       else '10000000-0000-4000-8000-000000000002' end;
begin
  return format('select count(*) from api.policy_list(%L, %L, %L, %s, %s)', a, s, test.staff_token(a, s), p_limit, p_offset);
end $$;

set role app_staff;
select test.expect_ok(test.plist('owner', 50), 'L1 owner 정책 목록 조회');
select test.expect_ok(test.plist('editor', 50), 'L2 policy_editor 정책 목록 조회');
select test.expect_error(test.plist('counselor', 50), '42501', 'L3 상담원은 정책 목록 조회 불가');
select test.expect_error(test.plist('owner', 0), '22023', 'L4 limit 0 거부');
select test.expect_error(test.plist('owner', 101), '22023', 'L5 limit 101 거부');
select test.expect_error(test.plist('owner', 10, -1), '22023', 'L6 음수 offset 거부');
reset role;

set role app_public;
select test.expect_error($$select count(*) from api.policy_list('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'x', 10, 0)$$, '42501', 'L8 공개 역할은 정책 목록 함수 실행 불가');
reset role;
select test.expect_eq($$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api' and p.proname = 'policy_list' and p.prosecdef and p.provolatile = 's' and array_to_string(p.proconfig, ',') like '%search_path=%'$$, '1', 'L9 security definer·stable·search_path 고정');
select test.expect_eq($$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api' and p.proname = 'policy_list' and p.prosrc ~* '(commission|settlement|source_ref)'$$, '0', 'L10 조회 함수에 수수료·원문 위치 없음');
