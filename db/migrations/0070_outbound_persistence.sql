-- 0070 광고성 전화 수신거부·시도·판정 기록 영구화 (코사장 11/27, PR #47 위). 실제 발신 기능은 이 파일에 없다.
-- - 연락처 원문·이름·고지문·상담 내용·금액 없음. 사업자 ID + 연락처 HMAC(64자 소문자 hex)만.
-- - 네 표(수신거부·시도·시도 결과·판정) 모두 추가 전용: UPDATE·DELETE·TRUNCATE 금지(트리거). 수신거부 해제 경로 없음.
-- - 시도 상한(누적 3회)·간격(24시간)은 DB가 직접 센다(호출자 숫자 불신). 같은 대상의 수신거부 기록·시도 시작은 같은 advisory lock으로 직렬화.
-- - 시도 결과는 해당 사업자의 시도에만 기록(타 사업자 시도 ID로 처리 불가).
-- - 판정 기록: 허용·차단 모두. 기록 실패 시 발신하지 않는 계약은 서버 어댑터(src/server/outbound/db.ts)가 지킨다.
-- - 권한: 표는 fideon_api만(RLS enable+force, zz_grants 일괄 정책). 함수 실행은 기존 통화 작업자 역할 app_call만(zz_grants).
--   SECURITY DEFINER는 기존 api 스키마 규칙(소유자 fideon_api·search_path 고정·PUBLIC/anon/authenticated 회수·입력 검증)을 따른다.
-- - 시각은 DB now()(서버 신뢰 시계). 호출자 시각 인자 없음.
begin;

create table if not exists core.outbound_suppressions (
  business_id text not null check (business_id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  phone_hmac  text not null check (phone_hmac ~ '^[0-9a-f]{64}$'),
  blocked_at  timestamptz not null default now(),
  primary key (business_id, phone_hmac)
);

create table if not exists core.outbound_attempts (
  id           bigint generated always as identity primary key,
  business_id  text not null check (business_id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  phone_hmac   text not null check (phone_hmac ~ '^[0-9a-f]{64}$'),
  purpose_id   text not null check (purpose_id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  mode         text not null check (mode in ('live_agent', 'ars_ad')),
  dialer       text not null check (dialer in ('manual', 'pds')),
  attempted_at timestamptz not null default now()
);
create index if not exists outbound_attempts_target on core.outbound_attempts (business_id, phone_hmac, attempted_at desc);

-- 시도 결과(시도당 1건, 추가 전용): 결과 코드만
create table if not exists core.outbound_attempt_results (
  attempt_id  bigint primary key references core.outbound_attempts(id),
  result      text not null check (result in ('placed', 'dial_failed', 'cancelled')),  -- cancelled: 시작 뒤 발신 전 취소(수신거부 재확인·기록 실패)
  recorded_at timestamptz not null default now()
);

create table if not exists core.outbound_decisions (
  id          bigint generated always as identity primary key,
  business_id text not null check (business_id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  phone_hmac  text not null check (phone_hmac ~ '^[0-9a-f]{64}$'),
  allowed     boolean not null,
  basis       text check (basis in ('consent', 'live_exception')),
  reasons     text[] not null check (cardinality(reasons) <= 20 and array_to_string(reasons, ',') ~ '^([A-Z_]{2,40}(,[A-Z_]{2,40})*)?$'),
  decided_at  timestamptz not null default now(),
  check ((allowed and basis is not null and cardinality(reasons) = 0) or (not allowed and basis is null and cardinality(reasons) >= 1))
);
create index if not exists outbound_decisions_target on core.outbound_decisions (business_id, phone_hmac, decided_at desc);

alter table core.outbound_suppressions enable row level security;
alter table core.outbound_suppressions force row level security;
alter table core.outbound_attempts enable row level security;
alter table core.outbound_attempts force row level security;
alter table core.outbound_attempt_results enable row level security;
alter table core.outbound_attempt_results force row level security;
alter table core.outbound_decisions enable row level security;
alter table core.outbound_decisions force row level security;

create or replace function core.outbound_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'OUTBOUND_APPEND_ONLY' using errcode = '42501';
end
$$;
do $$
declare t text;
begin
  foreach t in array array['outbound_suppressions', 'outbound_attempts', 'outbound_attempt_results', 'outbound_decisions'] loop
    execute format('drop trigger if exists %I on core.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on core.%I for each row execute function core.outbound_append_only()', t || '_append_only', t);
    execute format('drop trigger if exists %I on core.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on core.%I for each statement execute function core.block_truncate()', t || '_no_truncate', t);
  end loop;
end
$$;

create or replace function core.outbound_key_ok(p_business text, p_hmac text) returns boolean
language sql immutable set search_path = '' as $$
  select p_business ~ '^[a-z0-9][a-z0-9_-]{1,39}$' and p_hmac ~ '^[0-9a-f]{64}$'
$$;

-- 수신거부 기록(즉시, 멱등). 동시 호출에도 1행. 반환 'blocked'
create or replace function api.outbound_suppression_block(p_business text, p_hmac text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(core.outbound_key_ok(p_business, p_hmac), false) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('outbound:' || p_business || ':' || p_hmac, 0));  -- 시도 시작과 같은 잠금
  insert into core.outbound_suppressions (business_id, phone_hmac) values (p_business, p_hmac) on conflict do nothing;
  return 'blocked';
end
$$;

-- 수신거부 조회: 'blocked' | 'clear' + DB 시각
create or replace function api.outbound_suppression_check(p_business text, p_hmac text)
returns table (result text, checked_at timestamptz) language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(core.outbound_key_ok(p_business, p_hmac), false) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query select case when exists (select 1 from core.outbound_suppressions s where s.business_id = p_business and s.phone_hmac = p_hmac)
                           then 'blocked' else 'clear' end, now();
end
$$;

-- 시도 시작(발신 직전): DB가 누적 3회·24시간 간격·수신거부를 직접 확인하고 통과하면 1행 기록. 실패 사유는 예외 메시지
create or replace function api.outbound_attempt_begin(p_business text, p_hmac text, p_purpose text, p_mode text, p_dialer text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_total int;
  v_last  timestamptz;
  v_id    bigint;
begin
  if not coalesce(core.outbound_key_ok(p_business, p_hmac), false) or p_purpose is null or p_purpose !~ '^[a-z0-9][a-z0-9_-]{1,39}$'
     or p_mode is null or p_mode not in ('live_agent', 'ars_ad') or p_dialer is null or p_dialer not in ('manual', 'pds') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('outbound:' || p_business || ':' || p_hmac, 0));
  if exists (select 1 from core.outbound_suppressions s where s.business_id = p_business and s.phone_hmac = p_hmac) then
    raise exception 'OPTED_OUT' using errcode = '22023';
  end if;
  select count(*), max(a.attempted_at) into v_total, v_last
    from core.outbound_attempts a where a.business_id = p_business and a.phone_hmac = p_hmac;
  if v_total >= 3 then
    raise exception 'RETRY_LIMIT' using errcode = '22023';
  end if;
  if v_last is not null and v_last > now() - interval '24 hours' then
    raise exception 'RETRY_TOO_SOON' using errcode = '22023';
  end if;
  insert into core.outbound_attempts (business_id, phone_hmac, purpose_id, mode, dialer)
  values (p_business, p_hmac, p_purpose, p_mode, p_dialer) returning id into v_id;
  return v_id;
end
$$;

-- 시도 결과(시도당 1회). 해당 사업자의 시도만(다른 사업자 ID면 없음과 같은 NOT_FOUND)
create or replace function api.outbound_attempt_finish(p_business text, p_attempt bigint, p_result text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_business is null or p_business !~ '^[a-z0-9][a-z0-9_-]{1,39}$' or p_attempt is null
     or p_result is null or p_result not in ('placed', 'dial_failed', 'cancelled') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from core.outbound_attempts a where a.id = p_attempt and a.business_id = p_business) then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  insert into core.outbound_attempt_results (attempt_id, result) values (p_attempt, p_result);
exception when unique_violation then
  raise exception 'ALREADY_RECORDED' using errcode = '22023';
end
$$;

-- 시도 현황(DB 계산): 누적·최근 24시간·마지막 시각·지금 시작 가능 여부
create or replace function api.outbound_attempt_status(p_business text, p_hmac text)
returns table (total int, recent_24h int, last_at timestamptz, can_attempt boolean) language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(core.outbound_key_ok(p_business, p_hmac), false) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select count(*)::int, (count(*) filter (where a.attempted_at > now() - interval '24 hours'))::int, max(a.attempted_at),
         count(*) < 3 and coalesce(max(a.attempted_at) <= now() - interval '24 hours', true)
           and not exists (select 1 from core.outbound_suppressions s where s.business_id = p_business and s.phone_hmac = p_hmac)
    from core.outbound_attempts a where a.business_id = p_business and a.phone_hmac = p_hmac;
end
$$;

-- 판정 기록(허용·차단 모두). 사유 코드는 대문자·밑줄만, 최대 20개
create or replace function api.outbound_decision_record(p_business text, p_hmac text, p_allowed boolean, p_basis text, p_reasons text[])
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not coalesce(core.outbound_key_ok(p_business, p_hmac), false) or p_allowed is null or p_reasons is null
     or cardinality(p_reasons) > 20 or (p_basis is not null and p_basis not in ('consent', 'live_exception'))
     or exists (select 1 from unnest(p_reasons) r where r is null or r !~ '^[A-Z_]{2,40}$')
     or (p_allowed and (p_basis is null or cardinality(p_reasons) <> 0))
     or (not p_allowed and (p_basis is not null or cardinality(p_reasons) = 0)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into core.outbound_decisions (business_id, phone_hmac, allowed, basis, reasons)
  values (p_business, p_hmac, p_allowed, p_basis, p_reasons) returning id into v_id;
  return v_id;
end
$$;

revoke all on function core.outbound_append_only(), core.outbound_key_ok(text, text) from public;
-- 생성 직후 실행 권한을 모두 닫는다(PostgreSQL 기본 PUBLIC EXECUTE 제거). zz_grants.sql이 app_call에만 다시 연다
do $$
declare
  f text;
  r text;
begin
  foreach f in array array['api.outbound_suppression_block(text,text)', 'api.outbound_suppression_check(text,text)',
                           'api.outbound_attempt_begin(text,text,text,text,text)', 'api.outbound_attempt_finish(text,bigint,text)',
                           'api.outbound_attempt_status(text,text)', 'api.outbound_decision_record(text,text,boolean,text,text[])'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'app_public', 'app_staff', 'app_server', 'app_ai', 'app_ad_monitor', 'app_ad_scheduler', 'app_call', 'release_auditor'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end
$$;

commit;
