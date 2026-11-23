-- SEC-03 권한 전수 검사 (카탈로그). 관리자 연결로 실행.
\set ON_ERROR_STOP 1

\echo '--- [보고용] SECURITY DEFINER 함수와 EXECUTE 권한 보유 역할 ---'
select n.nspname || '.' || p.proname as function,
       pg_get_userbyid(p.proowner) as owner,
       coalesce(array_to_string(array(
         select r.rolname from pg_roles r
         where r.rolname in ('public', 'anon', 'authenticated', 'app_public', 'app_staff', 'app_server', 'app_ai', 'fideon_api')
           and has_function_privilege(r.oid, p.oid, 'EXECUTE')
         order by r.rolname), ', '), '') as execute_roles,
       coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%' as search_path_fixed
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname in ('core', 'pii', 'security', 'api')
order by 1;

-- 1) core·pii·security 모든 테이블 RLS + FORCE
select test.expect_eq($$
  select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('core', 'pii', 'security') and c.relkind in ('r', 'p')
    and not (c.relrowsecurity and c.relforcerowsecurity)$$, '0', 'G1 모든 테이블 RLS+FORCE');

-- 2) 앱 역할·PUBLIC의 테이블 권한 0
select test.expect_eq($$
  select count(*)::text from information_schema.role_table_grants
  where table_schema in ('core', 'pii', 'security')
    and grantee in ('PUBLIC', 'app_public', 'app_staff', 'app_server', 'app_ai')$$, '0', 'G2 앱 역할 테이블 권한 0');

-- 3) 앱 역할의 스키마 USAGE: api만
select test.expect_eq($$
  select string_agg(r || ':' || s, ',' order by r, s) from
    unnest(array['app_public', 'app_staff', 'app_server', 'app_ai']) r,
    unnest(array['core', 'pii', 'security', 'api', 'extensions']) s
  where has_schema_privilege(r, s, 'USAGE')$$, 'app_ai:api,app_public:api,app_staff:api', 'G3 앱 역할 USAGE는 api만');

-- 4) SECURITY DEFINER 함수는 모두 search_path 고정
select test.expect_eq($$
  select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname in ('core', 'pii', 'security', 'api')
    and not coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%'$$, '0', 'G4 search_path 고정');

-- 5) EXECUTE 권한 허용 목록과 실제 상태 일치 (앱 역할·PUBLIC 기준, 모든 스키마 함수 전수)
select test.expect_eq($$
  select coalesce(string_agg(x, ' ; ' order by x), '') from (
    select r.rolname || ' -> ' || p.proname as x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join (select oid, rolname from pg_roles where rolname in ('app_public', 'app_staff', 'app_server', 'app_ai')) r
    where n.nspname in ('core', 'pii', 'security', 'api')
      and has_function_privilege(r.oid, p.oid, 'EXECUTE')
    except
    select unnest(array[
      'app_public -> create_lead', 'app_public -> policy_published',
      'app_staff -> staff_session_open', 'app_staff -> staff_session_revoke', 'app_staff -> whoami',
      'app_staff -> list_leads', 'app_staff -> reveal_contact', 'app_staff -> update_lead',
      'app_staff -> assign_lead', 'app_staff -> export_leads_masked', 'app_staff -> set_feature_flag',
      'app_staff -> purge_customer',
      'app_staff -> policy_create_draft', 'app_staff -> policy_submit', 'app_staff -> policy_approve', 'app_staff -> policy_reject', 'app_staff -> policy_list',
      'app_staff -> ad_budget_approve', 'app_staff -> ad_budget_revoke', 'app_staff -> ad_spend_request', 'app_staff -> ad_budget_overview',
      'app_staff -> ad_performance_record', 'app_staff -> ad_funnel',
      'app_public -> consult_event_record', 'app_staff -> ad_funnel_full', 'app_staff -> ad_alert_open', 'app_staff -> ad_alert_resolve', 'app_staff -> ad_alert_list', 'app_staff -> ai_budget_limit_get', 'app_staff -> ai_budget_limit_set', 'app_staff -> policy_publish_get', 'app_staff -> policy_publish_set', 'app_staff -> notice_text_list', 'app_staff -> notice_text_add', 'app_public -> notice_intake_gate', 'app_public -> application_save', 'app_staff -> dealer_packet_get', 'app_staff -> dealer_packet_status', 'app_staff -> handoff_record', 'app_staff -> handoff_list', 'app_staff -> notice_review_add', 'app_staff -> notice_review_list',
      'app_staff -> ad_spend_request_window', 'app_public -> followup_request', 'app_public -> consult_rate_hit', 'app_public -> policy_intake_gate', 'app_staff -> followup_list', 'app_staff -> followup_done', 'app_staff -> ad_launch_begin', 'app_staff -> ad_launch_finish', 'app_staff -> ad_launch_active', 'app_staff -> ad_launch_paused', 'app_staff -> ad_launch_resolve', 'app_public -> application_amend', 'app_staff -> application_amendments',
      'app_ai -> ai_budget_hold', 'app_ai -> ai_budget_confirm', 'app_ai -> ai_budget_release', 'app_ai -> ai_budget_uncertain', 'app_staff -> ai_budget_limits_set', 'app_staff -> ai_budget_pause_set', 'app_staff -> ai_budget_adjust',  -- 0028
      -- app_server는 두 역할의 멤버지만 NOINHERIT라 직접 실행 권한이 없어야 한다
      'none'])
  ) t$$, '', 'G5 EXECUTE 허용 목록 외 권한 0');

select test.expect_eq($$
  select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('core', 'pii', 'security', 'api')
    and has_function_privilege('public', p.oid, 'EXECUTE')$$, null, 'G6 PUBLIC 실행 가능 함수 0');

-- 7) app_public은 관리자·내부 함수 실행 불가, app_staff는 상담 신청 실행 불가
select test.expect_eq($$
  select has_function_privilege('app_public', 'api.reveal_contact(uuid,uuid,text,uuid,text)', 'EXECUTE')::text
      || has_function_privilege('app_public', 'core.purge_expired()', 'EXECUTE')::text
      || has_function_privilege('app_staff', 'api.create_lead(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,text)', 'EXECUTE')::text
      || has_function_privilege('app_server', 'api.list_leads(uuid,uuid,text,int,int)', 'EXECUTE')::text$$,
  'falsefalsefalsefalse', 'G7 역할 간 함수 교차 실행 불가');

-- 8) api 함수 소유자는 fideon_api, fideon_api는 서명 키 테이블 권한 없음
select test.expect_eq($$
  select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api' and pg_get_userbyid(p.proowner) <> 'fideon_api'$$, '0', 'G8 api 함수 소유자 fideon_api');
select test.expect_eq($$
  select has_table_privilege('fideon_api', 'security.server_keys', 'SELECT')::text$$, 'false', 'G9 fideon_api 서명 키 조회 불가');
