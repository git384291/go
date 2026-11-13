-- catalog_audit.sql — 권한 위반 항목을 한 줄씩 출력한다. 출력이 0줄이어야 정상.
-- REV-004 SEC-05: 운영 배포 전에 '운영 DB 자체'를 검사하기 위해 만든다.
--   - 테이블 권한이 전혀 없는 읽기 전용 점검 계정(release_auditor)으로 실행한다.
--   - 그래서 information_schema.role_table_grants를 쓰지 않는다. 그 뷰는 일반 계정에게
--     다른 역할의 권한을 보여 주지 않아, 운영에서 위반이 있어도 '0건'으로 보일 수 있다.
--     대신 has_*_privilege(역할, 대상, 권한)으로 역할마다 직접 물어본다.
--   - 같은 파일을 로컬 테스트(scripts/db-test.sh)에서도 같은 계정으로 실행해 검증한다.
-- 허용 목록이 바뀌면 이 파일과 db/migrations/zz_grants.sql을 같은 커밋에서 함께 고친다.
with
app_roles(rolname) as (
  select r.rolname from pg_roles r
  where r.rolname in ('app_public', 'app_staff', 'app_server', 'anon', 'authenticated', 'release_auditor')
),
guarded_tables as (
  select c.oid, n.nspname || '.' || c.relname as name, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('core', 'pii', 'security') and c.relkind in ('r', 'p', 'v', 'm')
),
guarded_funcs as (
  select p.oid, n.nspname, n.nspname || '.' || p.proname as name, p.proname, p.prosecdef, p.proconfig, p.proowner
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('core', 'pii', 'security', 'api')
),
exec_allow(rolname, proname) as (
  values
    ('app_public', 'create_lead'),
    ('app_staff', 'staff_session_open'), ('app_staff', 'staff_session_revoke'), ('app_staff', 'whoami'),
    ('app_staff', 'list_leads'), ('app_staff', 'reveal_contact'), ('app_staff', 'update_lead'),
    ('app_staff', 'assign_lead'), ('app_staff', 'export_leads_masked'), ('app_staff', 'set_feature_flag'),
    ('app_staff', 'purge_customer')
),
violations(v) as (
  -- V1 모든 보호 테이블은 RLS + FORCE
  select 'V1 RLS/FORCE off: ' || t.name
  from guarded_tables t
  where t.oid in (select oid from pg_class where relkind in ('r', 'p'))
    and not (t.relrowsecurity and t.relforcerowsecurity)
  union all
  -- V2 앱 역할·PUBLIC·점검 계정은 보호 테이블에 어떤 권한도 없음(뷰 포함)
  select 'V2 table privilege: ' || r.rolname || ' on ' || t.name
  from guarded_tables t cross join app_roles r
  where has_table_privilege(r.rolname, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  union all
  select 'V2 table privilege: PUBLIC on ' || t.name
  from guarded_tables t
  where exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid = t.oid and a.grantee = 0)
  union all
  -- V3 스키마 USAGE: app_public·app_staff는 api만, 나머지 앱 역할은 없음
  select 'V3 schema usage: ' || r.rolname || ' on ' || s.nspname
  from app_roles r cross join pg_namespace s
  where s.nspname in ('core', 'pii', 'security', 'api', 'extensions')
    and has_schema_privilege(r.rolname, s.oid, 'USAGE')
    and not (r.rolname in ('app_public', 'app_staff') and s.nspname = 'api')
  union all
  -- V4 SECURITY DEFINER 함수는 search_path 고정
  select 'V4 search_path not fixed: ' || f.name
  from guarded_funcs f
  where f.prosecdef and not coalesce(array_to_string(f.proconfig, ','), '') like '%search_path=%'
  union all
  -- V5 EXECUTE 허용 목록 밖 권한 0 (PUBLIC 경유 권한도 has_function_privilege가 잡는다)
  select 'V5 execute not allowed: ' || r.rolname || ' -> ' || f.name
  from guarded_funcs f cross join app_roles r
  where has_function_privilege(r.rolname, f.oid, 'EXECUTE')
    and not (f.nspname = 'api' and (r.rolname, f.proname) in (select rolname, proname from exec_allow))
  union all
  -- V6 api 함수 소유자는 fideon_api
  select 'V6 api owner: ' || f.name || ' owned by ' || pg_get_userbyid(f.proowner)
  from guarded_funcs f
  where f.nspname = 'api' and pg_get_userbyid(f.proowner) <> 'fideon_api'
  union all
  -- V7 서명 키 테이블은 함수 소유자(fideon_api)도 읽을 수 없음
  -- (점검 계정은 security 스키마 USAGE가 없으므로 이름 대신 카탈로그의 oid로 묻는다)
  select 'V7 signing keys readable by fideon_api'
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'security' and c.relname = 'server_keys'
    and has_table_privilege('fideon_api', c.oid, 'SELECT')
  union all
  -- V8 보호 테이블의 RLS 정책은 fideon_api(키 테이블은 마이그레이션 역할)에게만
  select 'V8 policy for unexpected role: ' || p.schemaname || '.' || p.tablename || ' ' || p.policyname
         || ' to ' || array_to_string(p.roles, ',')
  from pg_policies p
  where p.schemaname in ('core', 'pii', 'security')
    and not (p.roles = array['fideon_api']::name[]
             or (p.schemaname = 'security' and p.tablename = 'server_keys' and p.policyname = 'key_reader'))
  union all
  -- V9 로그인 가능한 앱 역할은 app_server와 release_auditor뿐, 둘 다 슈퍼유저·RLS 우회 아님
  select 'V9 role attribute: ' || r.rolname
  from pg_roles r
  where r.rolname in ('app_public', 'app_staff', 'fideon_api', 'app_server', 'release_auditor')
    and (r.rolsuper or r.rolbypassrls
         or (r.rolcanlogin and r.rolname not in ('app_server', 'release_auditor')))
)
select v from violations order by v;
