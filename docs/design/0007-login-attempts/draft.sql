-- ============================================================================
-- 설계 초안 0007 — 로그인 시도 제한(예약·정산). **정식 마이그레이션 아님.**
-- - db/migrations에 넣지 않는다. 앱·CI·운영 DB에서 자동 실행되지 않는다.
-- - scripts/design/login-attempts-local.sh가 만든 로컬 폐기용 DB에서만 실행한다.
-- - 설계: docs/ADMIN-AUTH-OPERATIONS.md 6·8절, 계약: CONTRACT.md
-- ============================================================================
\set ON_ERROR_STOP 1
begin;

-- [제안 P-1] 서명 목적 'login' 추가(기존 staff·lead 키와 분리). 정식 반영 시 0001 제약 변경 필요.
alter table security.server_keys drop constraint if exists server_keys_purpose_check;
alter table security.server_keys add constraint server_keys_purpose_check check (purpose in ('staff', 'lead', 'login'));

-- 시도 기록: 원문 이메일·IP 없음(서버가 HMAC·해시로 보냄), 7일 보존(정리는 제안 P-6)
create table security.login_attempts (
  id            uuid primary key default gen_random_uuid(),
  step          text not null check (step in ('password', 'totp')),
  subject_hmac  text not null check (subject_hmac ~ '^[0-9a-f]{64}$'),
  ip_hash       text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  request_nonce text not null unique check (request_nonce ~ '^[0-9a-f]{32}$'),
  created_at    timestamptz not null default now(),
  settled_at    timestamptz,
  result        text check (result in ('success', 'failure', 'expired')),
  check ((result is null) = (settled_at is null))
);
create index login_attempts_subject on security.login_attempts (step, subject_hmac, created_at);
create index login_attempts_ip on security.login_attempts (ip_hash, created_at);

alter table security.login_attempts enable row level security;
alter table security.login_attempts force row level security;
revoke all on security.login_attempts from public;
grant select, insert, update on security.login_attempts to fideon_api;           -- [제안 P-2] zz_grants 4)항
create policy fideon_api_all on security.login_attempts to fideon_api using (true) with check (true);

-- 한도(초안 상수. 정식 반영 시 core.settings로 옮길지 결정 필요 — 제안 P-5)
--  비밀번호: (대상, IP) 15분 5회 / IP 전체 15분 20회. 대상 전체는 잠그지 않음(대표 알림은 제안 P-7)
--  TOTP: 사용자(대상) 15분 5회
create or replace function security.login_limit_count(p_step text, p_subject text, p_ip text, p_scope text)
returns int
language sql stable set search_path = '' as $$
  -- 실패·만료·대기(결과 없음)를 모두 센다(fail-closed).
  -- 대상 범위는 그 대상·단계의 '마지막 성공 예약 생성 시각' 이후 것만 센다 →
  -- 늦게 확정된 성공은 자기보다 먼저 만들어진 실패만 지우고, 이후 실패는 지우지 않는다.
  select count(*)::int
  from security.login_attempts a
  where a.created_at > now() - interval '15 minutes'
    and coalesce(a.result, 'pending') <> 'success'
    and case p_scope
      when 'subject_ip' then a.step = p_step and a.subject_hmac = p_subject and a.ip_hash = p_ip
        and a.created_at > coalesce((select max(s.created_at) from security.login_attempts s
                                     where s.step = p_step and s.subject_hmac = p_subject and s.result = 'success'), '-infinity')
      when 'subject' then a.step = p_step and a.subject_hmac = p_subject
        and a.created_at > coalesce((select max(s.created_at) from security.login_attempts s
                                     where s.step = p_step and s.subject_hmac = p_subject and s.result = 'success'), '-infinity')
      when 'ip' then a.ip_hash = p_ip                      -- IP 버킷은 성공으로 초기화하지 않는다
      else false end
$$;

-- 보조 함수들은 security invoker: api 함수 소유자(fideon_api)의 권한으로만 실행된다(정의자 권한 확대 없음).
-- 잠금: 네임스페이스 고정 문자열, 항상 대상 → IP 순서(교착 방지). lock_timeout은 호출 함수의 SET으로 제한.
create or replace function security.login_lock(p_step text, p_subject text, p_ip text)
returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('fideon.login.subject:' || p_step || ':' || p_subject, 0));
  perform pg_advisory_xact_lock(hashtextextended('fideon.login.ip:' || p_ip, 0));
end
$$;

-- 결과 없이 60초가 지난 예약 → 'expired'(실패로 셈). 잠금 범위 안에서만 호출.
create or replace function security.login_expire_stale(p_step text, p_subject text, p_ip text)
returns void
language sql volatile set search_path = '' as $$
  update security.login_attempts
     set result = 'expired', settled_at = now()
   where result is null and created_at < now() - interval '60 seconds'
     and ((step = p_step and subject_hmac = p_subject) or ip_hash = p_ip)
$$;

-- 서명 토큰의 만료가 지금부터 60초 이내인지(verify_token은 최대 300초까지 허용하므로 더 좁힌다)
create or replace function security.login_token_short(p_token text)
returns boolean
language sql stable set search_path = '' as $$
  select p_token ~ '^[0-9]{1,6}\.[0-9]{9,12}\.[0-9a-f]{64}$'
     and split_part(p_token, '.', 2)::bigint <= floor(extract(epoch from now()))::bigint + 60
$$;

-- 예약: 서버 서명(목적 login, 'reserve-request'·단계·대상·IP·nonce)이 맞고, nonce 1회, 한도 미만일 때만 행 생성
create or replace function api.login_attempt_reserve(p_step text, p_subject text, p_ip text, p_nonce text, p_token text)
returns uuid
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  v_id uuid;
begin
  if p_step is null or p_step not in ('password', 'totp')
     or p_subject !~ '^[0-9a-f]{64}$' or p_ip !~ '^[0-9a-f]{64}$' or p_nonce !~ '^[0-9a-f]{32}$'
     or not security.login_token_short(p_token)
     or not security.verify_token('login', p_token, array['reserve-request', p_step, p_subject, p_ip, p_nonce]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform security.login_lock(p_step, p_subject, p_ip);
  perform security.login_expire_stale(p_step, p_subject, p_ip);

  if exists (select 1 from security.login_attempts where request_nonce = p_nonce) then
    raise exception 'NONCE_REUSED' using errcode = '42501';
  end if;
  if security.login_limit_count(p_step, p_subject, p_ip, case p_step when 'totp' then 'subject' else 'subject_ip' end) >= 5
     or (p_step = 'password' and security.login_limit_count(p_step, p_subject, p_ip, 'ip') >= 20) then
    raise exception 'LOGIN_RATE_LIMITED' using errcode = 'P0429';
  end if;

  insert into security.login_attempts (step, subject_hmac, ip_hash, request_nonce)
  values (p_step, p_subject, p_ip, p_nonce)
  returning id into v_id;
  return v_id;
end
$$;

-- 정산: 서버 서명(목적 login, 'settle'·예약ID·단계·대상·IP·결과)이 맞아야 한다. 결과 자체가 서명 대상.
--  - 첫 확정만 기록(멱등): 같은 결과 재전송 → 'already', 다른 결과 → RESULT_CONFLICT
--  - 결과 없이 60초가 지난 예약은 'expired'로 확정되고 success로 바꿀 수 없다
create or replace function api.login_attempt_settle(p_id uuid, p_result text, p_token text)
returns text
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  v_row security.login_attempts;
begin
  select * into v_row from security.login_attempts where id = p_id;     -- 불변 열(단계·대상·IP)만 먼저 읽는다
  if not found or p_result is null or p_result not in ('success', 'failure')
     or not security.login_token_short(p_token)
     or not security.verify_token('login', p_token,
          array['settle', p_id::text, v_row.step, v_row.subject_hmac, v_row.ip_hash, p_result]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform security.login_lock(v_row.step, v_row.subject_hmac, v_row.ip_hash);   -- reserve와 같은 순서
  perform security.login_expire_stale(v_row.step, v_row.subject_hmac, v_row.ip_hash);
  select * into v_row from security.login_attempts where id = p_id for update;

  if v_row.result is not null then
    if v_row.result = p_result then
      return 'already';
    end if;
    raise exception 'RESULT_CONFLICT' using errcode = '42501';
  end if;
  update security.login_attempts set result = p_result, settled_at = now() where id = p_id;
  return 'settled';
end
$$;

-- 소유자·실행 권한(기존 zz_grants 6·7항 방식). [제안 P-2·P-3] 정식 반영 시 zz_grants 허용 목록에 추가 필요
alter function api.login_attempt_reserve(text, text, text, text, text) owner to fideon_api;
alter function api.login_attempt_settle(uuid, text, text) owner to fideon_api;
revoke all on function api.login_attempt_reserve(text, text, text, text, text), api.login_attempt_settle(uuid, text, text) from public;
revoke all on function security.login_limit_count(text, text, text, text), security.login_lock(text, text, text),
  security.login_expire_stale(text, text, text), security.login_token_short(text) from public;
grant execute on function security.login_limit_count(text, text, text, text), security.login_lock(text, text, text),
  security.login_expire_stale(text, text, text), security.login_token_short(text), security.verify_token(text, text, text[]) to fideon_api;
grant execute on function api.login_attempt_reserve(text, text, text, text, text), api.login_attempt_settle(uuid, text, text) to app_public;

commit;
