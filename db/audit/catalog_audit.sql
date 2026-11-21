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
  where r.rolname in ('app_public', 'app_staff', 'app_server', 'app_ai', 'anon', 'authenticated', 'release_auditor')
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
    ('app_public', 'create_lead'), ('app_public', 'policy_published'),
    ('app_staff', 'staff_session_open'), ('app_staff', 'staff_session_revoke'), ('app_staff', 'whoami'),
    ('app_staff', 'list_leads'), ('app_staff', 'reveal_contact'), ('app_staff', 'update_lead'),
    ('app_staff', 'assign_lead'), ('app_staff', 'export_leads_masked'), ('app_staff', 'set_feature_flag'),
    ('app_staff', 'purge_customer'),
    -- 0008 정책 저장소(PM 11/21): 쓰기 함수 4개는 직원 서명·역할로, 게시 조회는 고객 견적 필드만 돌려준다
    ('app_staff', 'policy_create_draft'), ('app_staff', 'policy_submit'), ('app_staff', 'policy_approve'), ('app_staff', 'policy_reject'), ('app_staff', 'policy_list'),
    -- 0010 광고 예산 통제(PM 11/21)
    ('app_staff', 'ad_budget_approve'), ('app_staff', 'ad_budget_revoke'), ('app_staff', 'ad_spend_request'), ('app_staff', 'ad_budget_overview'),
    -- 0011 광고 성과 수집·분석, AI 사용료 예약(전용 역할)
    ('app_staff', 'ad_performance_record'), ('app_staff', 'ad_funnel'), ('app_ai', 'ai_budget_reserve'),
    -- 0012 상담 시작 집계·전환 분석·AI 정산
    ('app_public', 'consult_event_record'), ('app_staff', 'ad_funnel_full'), ('app_staff', 'ad_alert_open'), ('app_staff', 'ad_alert_resolve'), ('app_staff', 'ad_alert_list'), ('app_staff', 'ai_budget_limit_get'), ('app_staff', 'ai_budget_limit_set'), ('app_staff', 'policy_publish_get'), ('app_staff', 'policy_publish_set'), ('app_staff', 'notice_text_list'), ('app_staff', 'notice_text_add'), ('app_public', 'notice_intake_gate'), ('app_public', 'application_save'), ('app_staff', 'dealer_packet_get'), ('app_staff', 'dealer_packet_status'), ('app_staff', 'handoff_record'), ('app_staff', 'handoff_list'), ('app_staff', 'notice_review_add'), ('app_staff', 'notice_review_list'),
    ('app_ai', 'ai_budget_hold'), ('app_ai', 'ai_budget_confirm'), ('app_ai', 'ai_budget_release'),
    -- PHASE 1 최종 보완: 점검 계정은 읽기 전용 점검 함수 1개만 실행한다(테이블 권한은 계속 0, V2)
    ('release_auditor', 'release_probe_product_scope')
),
-- PHASE 1 보완(검수 지적 3항): 상품 비활성화 구조의 보호 장치가 실제로 켜져 있는지
required_triggers(tbl, tgname) as (
  values
    ('core.product_catalog', 'product_catalog_guard'),
    ('core.product_catalog', 'product_catalog_no_truncate'),
    ('core.product_activation_approvals', 'product_approval_guard'),
    ('core.product_activation_approvals', 'product_approvals_no_truncate')
),
-- PHASE 1 최종 보완: 상품 차단에 관여하는 함수 본문은 검수된 마이그레이션과 '완전히 같아야' 한다(V11의 문자열 포함 검사 보강).
-- 값 = md5(마이그레이션 파일에서 각 함수의 마지막 정의 본문). tests/unit/release-probe.test.ts가 파일에서 다시 계산해 대조한다.
-- 함수를 고치면 이 값도 같은 커밋에서 바꿔야 하며, 바꾸지 않으면 배포 전 점검이 막는다.
-- 점검 계정은 core 스키마 USAGE가 없으므로 이름 해석(to_regprocedure) 대신 시스템 카탈로그를 직접 조인한다(인자는 타입 목록으로 비교).
pinned_funcs(nsp, fname, args, body_md5) as (
  values
    ('api', 'create_lead', 'text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text', '684c04bb7dc8d75721ecb0f82a2c09c0'),  -- 0007 필수 고지 반영본(롤백 시 이전 a99eddfc2884a4e7e588925a5664c811로 되돌린다)
    ('core', 'notice_texts_guard', '', '1f63bb70b44a56550fec3c6a2c6cd866'),
    ('core', 'product_catalog_guard', '', '197931d02b9aa30e9fe7406aba652784'),
    ('core', 'product_approval_guard', '', '9ef087dbd466ef5e1c2f57836a2fff7e'),
    ('core', 'block_truncate', '', '21175b027aefee1a01758c8feb061da8'),
    ('api', 'release_probe_product_scope', '', '6727db2084fb25adc4cbed5503c08f38')
),
required_unique_indexes(idx) as (
  values ('product_approvals_proof_once'), ('product_approvals_one_open')
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
    and not (r.rolname in ('app_public', 'app_staff', 'app_ai', 'release_auditor') and s.nspname = 'api')
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
  where r.rolname in ('app_public', 'app_staff', 'app_ai', 'fideon_api', 'app_server', 'release_auditor')
    and (r.rolsuper or r.rolbypassrls
         or (r.rolcanlogin and r.rolname not in ('app_server', 'release_auditor')))
  union all
  -- V10 상품 상태·승인 보호 트리거가 존재하고 켜져 있음(O = 일반 활성, A = 항상 활성). 꺼짐(D)·복제 전용(R)·없음은 위반
  select 'V10 protection trigger missing or disabled: ' || r.tbl || ' ' || r.tgname
  from required_triggers r
  where not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname || '.' || c.relname = r.tbl and t.tgname = r.tgname and t.tgenabled in ('O', 'A'))
  union all
  -- V11 상담 신청 함수가 DB 기준 상품 상태를 확인함(0004 이전 본문으로 되돌아가면 위반)
  select 'V11 api.create_lead without product check'
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname = 'create_lead'
      and p.prosrc like '%core.product_catalog%' and p.prosrc like '%PRODUCT_NOT_ACTIVE%')
  union all
  -- V12 승인 서명 1회용·미소진 승인 1건 고유 인덱스가 존재하고 유효함
  select 'V12 approval unique index missing or invalid: ' || r.idx
  from required_unique_indexes r
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_index i on i.indexrelid = c.oid
    where n.nspname = 'core' and c.relname = r.idx and i.indisunique and i.indisvalid)
  union all
  -- V13 상품 차단 함수 본문이 검수본과 다르거나 없음(주석 한 글자 변경도 감지)
  select 'V13 function body differs from reviewed migration: ' || p.nsp || '.' || p.fname || '(' || p.args || ')'
  from pinned_funcs p
  where not exists (
    select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = p.nsp and f.proname = p.fname
      and oidvectortypes(f.proargtypes) = p.args and md5(f.prosrc) = p.body_md5)
  union all
  -- V14 점검 함수 자체가 읽기 전용(STABLE)·SECURITY DEFINER·집합 반환 형태를 유지
  select 'V14 release probe must be STABLE SECURITY DEFINER returning setof text'
  where not exists (
    select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'api' and f.proname = 'release_probe_product_scope'
      and oidvectortypes(f.proargtypes) = ''
      and f.provolatile = 's' and f.prosecdef and f.proretset and f.prorettype = 'text'::regtype)
  union all
  -- V15 실제 차단 동작: 운영 데이터에 상담 신청 함수와 같은 조건식을 적용한 결과(읽기 전용)
  --     예약 상품이 접수 가능, 인터넷+TV가 차단, 상품 목록 변경, 진행 중인 활성화 승인 → 위반
  select 'V15 ' || probe.v
  from api.release_probe_product_scope() as probe(v)
)
select v from violations order by v;
