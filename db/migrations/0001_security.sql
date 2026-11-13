-- 0001_security.sql
-- 역할, 스키마, 관리자 세션 증명(서명 + 자체 세션 테이블)
-- REV-004 SEC-01: 세션 ID 단독 인증 금지, Supabase 내부 테이블(auth.sessions) 비의존
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fideon_api') then
    create role fideon_api nologin;          -- api 함수 소유자. 테이블 권한을 가진 유일한 앱 측 역할
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_public') then
    create role app_public nologin;          -- 공개 요청(상담 신청)
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_staff') then
    create role app_staff nologin;           -- 관리자 요청
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_server') then
    create role app_server login noinherit;  -- 서버 접속용. 권한 없음, 역할 전환만 가능
  end if;
end
$$;
grant app_public, app_staff to app_server;

create schema if not exists core;
create schema if not exists pii;
create schema if not exists security;
create schema if not exists api;

-- 서버 서명 키. 값은 마이그레이션에 넣지 않고 배포 절차(scripts)로 등록한다.
create table security.server_keys (
  key_id     int  not null,
  purpose    text not null check (purpose in ('staff', 'lead')),
  secret     bytea not null check (length(secret) >= 32),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (purpose, key_id)
);

create table core.staff (
  user_id    uuid primary key,                -- 인증 서비스의 사용자 ID. auth 스키마에 FK를 걸지 않는다
  role       text not null check (role in ('owner', 'counselor', 'policy_editor', 'reviewer')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- 자체 관리자 세션. 로그아웃·강제 종료 시 revoked_at을 기록한다.
create table security.staff_sessions (
  id         uuid primary key,
  user_id    uuid not null references core.staff(user_id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index staff_sessions_user on security.staff_sessions (user_id);

create table core.audit_logs (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  reason      text,
  detail      jsonb
);
create index audit_logs_actor_action_at on core.audit_logs (actor_id, action, at);
create index audit_logs_action_at on core.audit_logs (action, at);

-- 서버 서명 검증
-- 토큰: '<key_id>.<만료 epoch 초>.<hex 서명>'
-- 서명 대상: 'fideon|<purpose>|<key_id>|<exp>|sha256(f1)|sha256(f2)|...'
--   각 필드를 sha256 hex로 바꿔 이어 붙이므로 필드 안의 '|' 등으로 경계를 위조할 수 없다.
create or replace function security.verify_token(p_purpose text, p_token text, p_fields text[])
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_parts  text[];
  v_kid    int;
  v_exp    bigint;
  v_secret bytea;
  v_msg    text;
  v_now    bigint := floor(extract(epoch from now()))::bigint;
begin
  if p_token is null or p_token !~ '^[0-9]{1,6}\.[0-9]{9,12}\.[0-9a-f]{64}$' then
    return false;
  end if;
  v_parts := string_to_array(p_token, '.');
  v_kid := v_parts[1]::int;
  v_exp := v_parts[2]::bigint;
  if v_exp < v_now or v_exp > v_now + 300 then        -- 최대 5분 유효
    return false;
  end if;

  select k.secret into v_secret
  from security.server_keys k
  where k.purpose = p_purpose and k.key_id = v_kid and k.active;
  if v_secret is null then
    return false;
  end if;

  select 'fideon|' || p_purpose || '|' || v_kid || '|' || v_exp || coalesce(
           string_agg('|' || encode(extensions.digest(convert_to(coalesce(f, ''), 'UTF8'), 'sha256'), 'hex'),
                      '' order by ord), '')
    into v_msg
  from unnest(p_fields) with ordinality as t(f, ord);

  return encode(extensions.hmac(convert_to(v_msg, 'UTF8'), v_secret, 'sha256'), 'hex') = v_parts[3];
end
$$;

-- 관리자 확인: 서버 서명(행위자 + 세션 결합) + 자체 세션 테이블 + 관리자 테이블
create or replace function security.assert_staff(p_actor uuid, p_session uuid, p_token text, p_allowed text[])
returns core.staff
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  if p_actor is null or p_session is null
     or not security.verify_token('staff', p_token, array[p_actor::text, p_session::text]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select st.* into v_staff
  from security.staff_sessions s
  join core.staff st on st.user_id = s.user_id
  where s.id = p_session
    and s.user_id = p_actor
    and s.revoked_at is null
    and s.created_at > now() - interval '12 hours'
    and st.active
    and st.role = any (p_allowed);

  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return v_staff;
end
$$;

-- 로그인 직후 서버가 호출. 서명 목적이 달라('staff' 아님) 일반 요청 토큰으로는 세션을 만들 수 없다.
create or replace function api.staff_session_open(p_actor uuid, p_session uuid, p_token text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_owner uuid;
begin
  if not security.verify_token('staff', p_token, array['session-open', p_actor::text, p_session::text, 'aal2']) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select s.role into v_role from core.staff s where s.user_id = p_actor and s.active;
  if v_role is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  insert into security.staff_sessions (id, user_id) values (p_session, p_actor)
  on conflict (id) do nothing;
  select s.user_id into v_owner from security.staff_sessions s where s.id = p_session;
  if v_owner <> p_actor then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  insert into core.audit_logs (actor_id, action, target_type, target_id)
  values (p_actor, 'staff.session_open', 'staff_session', p_session);
  return v_role;
end
$$;

create or replace function api.staff_session_revoke(p_actor uuid, p_session uuid, p_token text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor', 'policy_editor', 'reviewer']);
  update security.staff_sessions set revoked_at = now() where id = p_session and revoked_at is null;
  insert into core.audit_logs (actor_id, action, target_type, target_id)
  values (p_actor, 'staff.session_revoke', 'staff_session', p_session);
end
$$;

create or replace function api.whoami(p_actor uuid, p_session uuid, p_token text)
returns table (user_id uuid, role text)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor', 'policy_editor', 'reviewer']);
  return query select v_staff.user_id, v_staff.role;
end
$$;

commit;
