-- zz_grants.sql — 모든 마이그레이션 뒤에 매번 실행하는 멱등 권한 스크립트
-- REV-004 SEC-03: 공개/관리자 분리, SECURITY DEFINER 실행 권한 허용 목록
begin;

grant fideon_api to current_user;    -- 함수 소유자 변경을 위해 필요

-- 1) PUBLIC 및 Supabase 기본 역할, 앱 역할에서 전부 회수
do $$
declare
  r text;
begin
  foreach r in array array['public', 'anon', 'authenticated', 'app_public', 'app_staff', 'app_server'] loop
    if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema core, pii, security, api from %s', r);
      execute format('revoke all on all tables in schema core, pii, security from %s', r);
      execute format('revoke all on all sequences in schema core, pii, security from %s', r);
      execute format('revoke all on all functions in schema core, pii, security, api from %s', r);
    end if;
  end loop;
end
$$;

-- 2) 앞으로 만들 객체의 기본 권한
alter default privileges in schema core, pii, security, api revoke all on tables from public;
alter default privileges in schema core, pii, security, api revoke execute on functions from public;
alter default privileges in schema core, pii, security revoke all on sequences from public;

-- 3) 스키마 USAGE
grant usage on schema api to app_public, app_staff;
grant usage on schema core, pii, security, api, extensions to fideon_api;
grant create on schema api to fideon_api;

-- 4) 테이블 권한: fideon_api만. security.server_keys는 제외(서명 검증 함수만 읽음)
grant select, insert, update on all tables in schema core to fideon_api;
grant select, insert, update, delete on all tables in schema pii to fideon_api;
grant select, insert, update on security.staff_sessions to fideon_api;
grant usage on all sequences in schema core, pii to fideon_api;
revoke update, delete on core.audit_logs from fideon_api;          -- 감사 로그는 추가 전용
revoke all on security.server_keys from fideon_api;

-- 5) RLS: core·pii·security 모든 테이블 enable + force, 허용 정책은 fideon_api만
do $$
declare
  r record;
begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('core', 'pii', 'security') loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
    execute format('alter table %I.%I force row level security', r.schemaname, r.tablename);
    execute format('drop policy if exists fideon_api_all on %I.%I', r.schemaname, r.tablename);
    if not (r.schemaname = 'security' and r.tablename = 'server_keys') then
      execute format('create policy fideon_api_all on %I.%I to fideon_api using (true) with check (true)',
                     r.schemaname, r.tablename);
    end if;
  end loop;
  -- 서명 키는 마이그레이션 실행 역할(= security.verify_token 소유자)만 읽는다.
  -- Supabase의 postgres 역할이 RLS 우회 속성이 없어도 동작하도록 명시 정책을 둔다.
  execute 'drop policy if exists key_reader on security.server_keys';
  execute format('create policy key_reader on security.server_keys for select to %I using (true)', current_user);
end
$$;

-- 6) api 함수 소유자 = fideon_api. security.* 함수는 마이그레이션 실행 역할 소유 유지
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
  loop
    execute format('alter function %s owner to fideon_api', f.sig);
  end loop;
end
$$;

-- 7) 함수 실행 권한 (허용 목록 — tests/db/10_grants.sql이 이 목록과 실제 상태를 대조)
grant execute on function
  security.assert_staff(uuid, uuid, text, text[]),
  security.verify_token(text, text, text[]),
  core.purge_customer_internal(uuid, uuid, text)
  to fideon_api;

grant execute on function
  api.create_lead(text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text)
  to app_public;

-- 정책 공개 조회는 공개·관리자 모두 (0004)
grant execute on function api.policy_current(text) to app_public, app_staff;

grant execute on function
  api.staff_session_open(uuid, uuid, text),
  api.staff_session_revoke(uuid, uuid, text),
  api.whoami(uuid, uuid, text),
  api.list_leads(uuid, uuid, text, int, int),
  api.reveal_contact(uuid, uuid, text, uuid, text),
  api.update_lead(uuid, uuid, text, uuid, text, text),
  api.assign_lead(uuid, uuid, text, uuid, uuid),
  api.export_leads_masked(uuid, uuid, text, date, date),
  api.set_feature_flag(uuid, uuid, text, text, boolean, text),
  api.purge_customer(uuid, uuid, text, uuid, text),
  api.policy_create(uuid, uuid, text, text, text, text),
  api.policy_approve(uuid, uuid, text, uuid, text),
  api.policy_publish(uuid, uuid, text, uuid, text),
  api.policy_list(uuid, uuid, text, text)
  to app_staff;

-- core.purge_expired()는 예약 작업(마이그레이션 역할)만 실행한다. 앱 역할에 부여하지 않는다.
-- AI 예산 함수(3단계)는 app_public이 아닌 서버 내부 전용 역할에만 부여한다(REV-004 SEC-04).

commit;
