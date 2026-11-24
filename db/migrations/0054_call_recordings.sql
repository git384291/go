-- 0054 고객 통화 녹취·저장 (PM 11/25 ①)
-- - 녹취 파일은 서버가 AES-256-GCM으로 암호화해 저장소에 올리고, DB에는 경로·해시·키 버전만 둔다(원문·연락처 원문 없음).
-- - 녹취 안내: 운영 설정의 안내 문구 버전과 통화의 안내 재생 버전이 같아야만 녹취를 보관한다. 다르면 'no_notice'로 기록하고 파일은 삭제 대기열로.
-- - 기본값은 전부 꺼짐(recording_enabled=false). 켜기는 대표만·사유 필수·감사 기록. 실제 활성화는 PM 승인 뒤에만 한다.
-- - 고객 연결: 연락처 HMAC이 같은 리드에만 자동 연결(최신 리드). 없으면 미연결(대표만 열람·연결). 다른 번호 연결은 대표 사유 필수.
-- - 중복: (통신사, 통화 ID) 유일. 같은 통화 재전송은 'exists'.
-- - 열람: 대표 또는 연결된 리드 담당자만, 사유 필수, 시간당 30회, 감사 기록. 미연결 통화는 대표만.
-- - 보존·삭제: 보존 기한 지난 녹취와 리드 파기 시 녹취를 지운다(파일은 삭제 대기열 → 서버가 저장소에서 삭제 후 완료 기록).
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_call') then
    create role app_call nologin;  -- 통화 수신·변환 작업 전용. 테이블 권한 없음, 통화 함수만 실행
  end if;
end
$$;
grant app_call to app_server;

create table if not exists core.call_settings (
  singleton             boolean primary key default true check (singleton),
  recording_enabled     boolean not null default false,
  stt_enabled           boolean not null default false,
  summary_enabled       boolean not null default false,
  notice_version        text check (notice_version is null or notice_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  retention_days        int not null default 90 check (retention_days between 1 and 1095),
  stt_monthly_cap_krw   int not null default 0 check (stt_monthly_cap_krw between 0 and 1000000),
  stt_price_per_min_krw int not null default 0 check (stt_price_per_min_krw between 0 and 1000),
  updated_by            uuid references core.staff(user_id),
  updated_at            timestamptz not null default now()
);
insert into core.call_settings (singleton) values (true) on conflict do nothing;

create table if not exists core.calls (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null check (provider ~ '^[a-z0-9_]{2,30}$'),
  provider_call_id text not null check (provider_call_id ~ '^[A-Za-z0-9._:-]{4,128}$'),
  direction        text not null check (direction in ('inbound', 'outbound')),
  lead_id          uuid references core.leads(id),
  link_method      text not null check (link_method in ('auto', 'unmatched', 'manual', 'manual_override')),
  ambiguous        boolean not null default false,       -- 같은 연락처 리드가 여러 건이었음(최신 리드에 연결)
  started_at       timestamptz not null,
  duration_sec     int not null check (duration_sec between 0 and 14400),
  notice_version   text check (notice_version is null or notice_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  recording_state  text not null check (recording_state in ('stored', 'no_notice', 'disabled', 'deleted')),
  agent_id         uuid references core.staff(user_id),
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (provider, provider_call_id),
  check ((link_method = 'unmatched') = (lead_id is null)),
  check ((recording_state = 'deleted') = (deleted_at is not null))
);
create index if not exists calls_lead on core.calls (lead_id, started_at desc);
create index if not exists calls_started on core.calls (started_at);

-- 연락처 HMAC·녹취 위치. 파기 시 행 전체 삭제.
create table if not exists pii.call_recordings (
  call_id         uuid primary key references core.calls(id),
  phone_hmac      text not null check (phone_hmac ~ '^[0-9a-f]{64}$'),
  storage_path    text unique check (storage_path is null or storage_path ~ '^calls/[0-9a-f-]{36}\.bin$'),
  audio_sha256    text check (audio_sha256 is null or audio_sha256 ~ '^[0-9a-f]{64}$'),
  audio_bytes     int check (audio_bytes is null or audio_bytes between 1 and 200000000),
  key_version     text check (key_version is null or key_version ~ '^[0-9]{1,6}$'),
  retention_until timestamptz not null,
  created_at      timestamptz not null default now(),
  check ((storage_path is null) = (audio_sha256 is null) and (storage_path is null) = (key_version is null) and (storage_path is null) = (audio_bytes is null))
);
create index if not exists call_recordings_hmac on pii.call_recordings (phone_hmac);
create index if not exists call_recordings_retention on pii.call_recordings (retention_until);

-- 저장소 파일 삭제 대기열(서버가 실제 삭제 후 done 기록)
create table if not exists core.call_object_deletions (
  storage_path text primary key check (storage_path ~ '^calls/[0-9a-f-]{36}\.bin$'),
  reason       text not null check (reason in ('disabled', 'no_notice', 'purge', 'retention', 'duplicate')),
  requested_at timestamptz not null default now(),
  done_at      timestamptz
);

-- 고객 연결 변경 이력(추가 전용)
create table if not exists core.call_links (
  id          bigint generated always as identity primary key,
  call_id     uuid not null references core.calls(id),
  from_lead   uuid references core.leads(id),
  to_lead     uuid not null references core.leads(id),
  method      text not null check (method in ('manual', 'manual_override')),
  actor_id    uuid not null references core.staff(user_id),
  reason      text check (reason is null or length(reason) between 2 and 500),
  created_at  timestamptz not null default now()
);
drop trigger if exists call_links_guard on core.call_links;
create trigger call_links_guard before update or delete on core.call_links for each row execute function core.ad_append_only();
drop trigger if exists call_links_no_truncate on core.call_links;
create trigger call_links_no_truncate before truncate on core.call_links for each statement execute function core.block_truncate();
drop trigger if exists calls_no_truncate on core.calls;
create trigger calls_no_truncate before truncate on core.calls for each statement execute function core.block_truncate();

-- 통화 행은 지우지 않는다(이력 보존). 상태·연결만 함수로 바뀐다.
create or replace function core.calls_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'APPEND_ONLY' using errcode = '42501';
  end if;
  if new.id <> old.id or new.provider <> old.provider or new.provider_call_id <> old.provider_call_id
     or new.direction <> old.direction or new.started_at <> old.started_at or new.duration_sec <> old.duration_sec
     or new.created_at <> old.created_at or (old.recording_state = 'deleted' and new.recording_state <> 'deleted') then
    raise exception 'IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists calls_guard on core.calls;
create trigger calls_guard before update or delete on core.calls for each row execute function core.calls_guard();

-- 대표 설정 변경
create or replace function api.call_settings_get(p_actor uuid, p_session uuid, p_token text)
returns table (recording_enabled boolean, stt_enabled boolean, summary_enabled boolean, notice_version text,
               retention_days int, stt_monthly_cap_krw int, stt_price_per_min_krw int, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  return query select s.recording_enabled, s.stt_enabled, s.summary_enabled, s.notice_version, s.retention_days,
                      s.stt_monthly_cap_krw, s.stt_price_per_min_krw, s.updated_at
                 from core.call_settings s where s.singleton;
end
$$;

create or replace function api.call_settings_set(p_actor uuid, p_session uuid, p_token text, p_settings jsonb, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   core.call_settings;
  k       text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 2 or length(p_reason) > 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' or p_settings = '{}'::jsonb then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_settings) loop
    if k not in ('recording_enabled', 'stt_enabled', 'summary_enabled', 'notice_version', 'retention_days',
                 'stt_monthly_cap_krw', 'stt_price_per_min_krw') then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  select * into v_old from core.call_settings s where s.singleton for update;
  begin
    update core.call_settings s set
      recording_enabled     = coalesce((p_settings->>'recording_enabled')::boolean, s.recording_enabled),
      stt_enabled           = coalesce((p_settings->>'stt_enabled')::boolean, s.stt_enabled),
      summary_enabled       = coalesce((p_settings->>'summary_enabled')::boolean, s.summary_enabled),
      notice_version        = case when p_settings ? 'notice_version' then p_settings->>'notice_version' else s.notice_version end,
      retention_days        = coalesce((p_settings->>'retention_days')::int, s.retention_days),
      stt_monthly_cap_krw   = coalesce((p_settings->>'stt_monthly_cap_krw')::int, s.stt_monthly_cap_krw),
      stt_price_per_min_krw = coalesce((p_settings->>'stt_price_per_min_krw')::int, s.stt_price_per_min_krw),
      updated_by = v_staff.user_id, updated_at = now()
    where s.singleton;
  exception when invalid_text_representation or check_violation or numeric_value_out_of_range then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end;
  -- 녹취를 켜려면 안내 문구 버전이 있어야 한다
  if exists (select 1 from core.call_settings s where s.singleton and s.recording_enabled and s.notice_version is null) then
    raise exception 'NOTICE_VERSION_REQUIRED' using errcode = '22023';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, reason, detail)
  values (v_staff.user_id, 'call.settings_set', 'call_settings', p_reason, p_settings);
end
$$;

-- 통화 저장 공용 삭제(파일 → 대기열, 연락처·위치 행 삭제, 상태 deleted). 앱 역할 실행 불가.
create or replace function core.call_purge_internal(p_call uuid, p_actor uuid, p_reason text)
returns void
language plpgsql set search_path = '' as $$
declare
  v_path text;
begin
  select r.storage_path into v_path from pii.call_recordings r where r.call_id = p_call for update;
  if v_path is not null then
    insert into core.call_object_deletions (storage_path, reason) values (v_path, case when p_reason = 'retention_expired' then 'retention' else 'purge' end)
    on conflict (storage_path) do nothing;
  end if;
  delete from pii.call_recordings r where r.call_id = p_call;
  update core.calls c set recording_state = 'deleted', deleted_at = now() where c.id = p_call and c.recording_state <> 'deleted';
  if found then
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason)
    values (p_actor, 'call.purge', 'call', p_call, p_reason);
  end if;
end
$$;

-- 통화 수신(서버 서명 필수). 반환: stored | no_notice | disabled | exists
create or replace function api.call_ingest(
  p_token text, p_provider text, p_provider_call_id text, p_direction text, p_phone_hmac text,
  p_started_epoch bigint, p_duration_sec int, p_notice_version text,
  p_storage_path text, p_audio_sha256 text, p_audio_bytes int, p_key_version text, p_agent uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_set    core.call_settings;
  v_state  text;
  v_lead   uuid;
  v_count  int;
  v_call   uuid;
  v_has_audio boolean := p_storage_path is not null;
begin
  if not security.verify_token('lead', p_token, array['call-ingest', p_provider, p_provider_call_id, p_direction, p_phone_hmac,
       p_started_epoch::text, p_duration_sec::text, p_notice_version, p_storage_path, p_audio_sha256, p_audio_bytes::text,
       p_key_version, p_agent::text]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$'
     or p_provider_call_id is null or p_provider_call_id !~ '^[A-Za-z0-9._:-]{4,128}$'
     or p_direction is null or p_direction not in ('inbound', 'outbound')
     or p_phone_hmac is null or p_phone_hmac !~ '^[0-9a-f]{64}$'
     or p_started_epoch is null or p_started_epoch < 1700000000 or p_started_epoch > extract(epoch from now())::bigint + 300
     or p_duration_sec is null or p_duration_sec not between 0 and 14400
     or (p_notice_version is not null and p_notice_version !~ '^[A-Za-z0-9._-]{1,40}$')
     or (v_has_audio and (p_storage_path !~ '^calls/[0-9a-f-]{36}\.bin$' or p_audio_sha256 is null or p_audio_sha256 !~ '^[0-9a-f]{64}$'
                          or p_audio_bytes is null or p_audio_bytes not between 1 and 200000000 or p_key_version is null or p_key_version !~ '^[0-9]{1,6}$'))
     or (not v_has_audio and (p_audio_sha256 is not null or p_audio_bytes is not null or p_key_version is not null)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_agent is not null and not exists (select 1 from core.staff s where s.user_id = p_agent and s.active) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('call:' || p_provider || ':' || p_provider_call_id, 0));
  if exists (select 1 from core.calls c where c.provider = p_provider and c.provider_call_id = p_provider_call_id) then
    -- 재전송: 이번에 올라온 파일이 기존 파일과 다르면 지운다(중복 저장 방지)
    if v_has_audio and not exists (select 1 from pii.call_recordings r where r.storage_path = p_storage_path) then
      insert into core.call_object_deletions (storage_path, reason) values (p_storage_path, 'duplicate') on conflict do nothing;
    end if;
    return 'exists';
  end if;

  select * into v_set from core.call_settings s where s.singleton;
  if not v_set.recording_enabled then
    v_state := 'disabled';
  elsif v_set.notice_version is null or p_notice_version is distinct from v_set.notice_version then
    v_state := 'no_notice';
  elsif not v_has_audio then
    v_state := 'no_notice';   -- 파일 없는 통화는 녹취 없음으로 기록
  else
    v_state := 'stored';
  end if;
  if v_state <> 'stored' and v_has_audio then
    insert into core.call_object_deletions (storage_path, reason) values (p_storage_path, case v_state when 'disabled' then 'disabled' else 'no_notice' end)
    on conflict do nothing;
  end if;

  -- 고객 연결: 같은 연락처 HMAC의 파기 안 된 리드 중 최신
  select count(*), (array_agg(l.id order by l.created_at desc))[1] into v_count, v_lead
    from core.leads l join pii.customers c on c.id = l.customer_id
   where c.phone_hmac = p_phone_hmac and l.purged_at is null;

  insert into core.calls (provider, provider_call_id, direction, lead_id, link_method, ambiguous, started_at, duration_sec,
                          notice_version, recording_state, agent_id)
  values (p_provider, p_provider_call_id, p_direction, v_lead, case when v_lead is null then 'unmatched' else 'auto' end,
          v_count > 1, to_timestamp(p_started_epoch), p_duration_sec, p_notice_version, v_state, p_agent)
  returning id into v_call;

  insert into pii.call_recordings (call_id, phone_hmac, storage_path, audio_sha256, audio_bytes, key_version, retention_until)
  values (v_call, p_phone_hmac,
          case when v_state = 'stored' then p_storage_path end,
          case when v_state = 'stored' then p_audio_sha256 end,
          case when v_state = 'stored' then p_audio_bytes end,
          case when v_state = 'stored' then p_key_version end,
          now() + make_interval(days => v_set.retention_days));

  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('call.ingest', 'call', v_call, jsonb_build_object('state', v_state, 'linked', v_lead is not null, 'ambiguous', v_count > 1));
  return v_state;
end
$$;

-- 담당 확인: 대표는 전부, 상담원은 연결된 리드 담당일 때만, 미연결 통화는 대표만
create or replace function core.call_visible(p_staff core.staff, p_call uuid)
returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from core.calls c left join core.leads l on l.id = c.lead_id
     where c.id = p_call
       and (p_staff.role = 'owner'
            or (p_staff.role = 'counselor' and c.lead_id is not null and l.assigned_to = p_staff.user_id)))
$$;

-- 녹취 듣기: 파일 위치·해시·키 버전만 돌려준다(복호화는 서버). 사유·감사·횟수 제한.
create or replace function api.call_recording_access(p_actor uuid, p_session uuid, p_token text, p_call uuid, p_reason text)
returns table (storage_path text, audio_sha256 text, key_version text)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor']);
  if length(btrim(coalesce(p_reason, ''))) < 2 or length(p_reason) > 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if not core.call_visible(v_staff, p_call)
     or not exists (select 1 from core.calls c where c.id = p_call and c.recording_state = 'stored') then
    raise exception 'FORBIDDEN' using errcode = '42501';   -- 없음·권한 없음·삭제됨을 구분하지 않는다
  end if;
  if (select count(*) from core.audit_logs a
       where a.actor_id = v_staff.user_id and a.action = 'call.listen' and a.at > now() - interval '1 hour') >= 30 then
    raise exception 'LISTEN_RATE_LIMITED' using errcode = '54000';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason)
  values (v_staff.user_id, 'call.listen', 'call', p_call, p_reason);
  return query select r.storage_path, r.audio_sha256, r.key_version from pii.call_recordings r where r.call_id = p_call;
end
$$;

-- 고객 연결(대표만). 같은 연락처면 manual, 다른 연락처면 manual_override(사유 5자 이상).
create or replace function api.call_link(p_actor uuid, p_session uuid, p_token text, p_call uuid, p_lead uuid, p_reason text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_call  core.calls;
  v_hmac  text;
  v_same  boolean;
  v_method text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  select * into v_call from core.calls c where c.id = p_call for update;
  if not found or v_call.recording_state = 'deleted' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select r.phone_hmac into v_hmac from pii.call_recordings r where r.call_id = p_call;
  select c.phone_hmac = v_hmac into v_same
    from core.leads l join pii.customers c on c.id = l.customer_id
   where l.id = p_lead and l.purged_at is null;
  if v_same is null then
    raise exception 'INVALID_LEAD' using errcode = '22023';   -- 없음·파기된 리드
  end if;
  if v_call.lead_id = p_lead then
    return 'unchanged';
  end if;
  v_method := case when v_same then 'manual' else 'manual_override' end;
  if length(btrim(coalesce(p_reason, ''))) < (case when v_same then 2 else 5 end) or length(p_reason) > 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  update core.calls set lead_id = p_lead, link_method = v_method, ambiguous = false where id = p_call;
  insert into core.call_links (call_id, from_lead, to_lead, method, actor_id, reason)
  values (p_call, v_call.lead_id, p_lead, v_method, v_staff.user_id, btrim(p_reason));
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'call.link', 'call', p_call, btrim(p_reason), jsonb_build_object('method', v_method, 'had_lead', v_call.lead_id is not null));
  return v_method;
end
$$;

-- 녹취 삭제(대표만, 사유 5자 이상)
create or replace function api.call_recording_delete(p_actor uuid, p_session uuid, p_token text, p_call uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 5 or length(p_reason) > 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from core.calls c where c.id = p_call and c.recording_state <> 'deleted') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform core.call_purge_internal(p_call, v_staff.user_id, btrim(p_reason));
end
$$;

-- 보존 기한 만료 삭제(예약 작업 전용, 앱 역할 실행 불가)
create or replace function core.purge_expired_calls() returns int
language plpgsql set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in select x.call_id from pii.call_recordings x where x.retention_until < now() order by x.retention_until limit 1000 loop
    perform core.call_purge_internal(r.call_id, null, 'retention_expired');
    n := n + 1;
  end loop;
  return n;
end
$$;

-- 리드 파기(purge_customer·보존 만료) 시 연결된 통화 녹취도 함께 삭제
create or replace function core.calls_on_lead_purge() returns trigger
language plpgsql set search_path = '' as $$
declare
  r record;
begin
  if new.purged_at is not null and old.purged_at is null then
    for r in select c.id from core.calls c where c.lead_id = new.id and c.recording_state <> 'deleted' loop
      perform core.call_purge_internal(r.id, null, 'lead_purged');
    end loop;
  end if;
  return null;
end
$$;
drop trigger if exists calls_on_lead_purge on core.leads;
create trigger calls_on_lead_purge after update of purged_at on core.leads for each row execute function core.calls_on_lead_purge();

-- 고객 전체 파기(pii.customers 삭제) 시: 같은 연락처의 다른 리드 연결·미연결 통화도 삭제(같은 연락처 고객 행이 더 없을 때)
create or replace function core.calls_on_customer_delete() returns trigger
language plpgsql set search_path = '' as $$
declare
  r record;
begin
  if not exists (select 1 from pii.customers c where c.phone_hmac = old.phone_hmac and c.id <> old.id) then
    for r in select x.call_id from pii.call_recordings x where x.phone_hmac = old.phone_hmac loop
      perform core.call_purge_internal(r.call_id, null, 'customer_purged');
    end loop;
  end if;
  return null;
end
$$;
drop trigger if exists calls_on_customer_delete on pii.customers;
create trigger calls_on_customer_delete after delete on pii.customers for each row execute function core.calls_on_customer_delete();

-- 저장소 삭제 대기열(서버 작업 전용)
create or replace function api.call_object_deletion_next(p_limit int)
returns table (storage_path text)
language sql security definer set search_path = '' as $$
  select d.storage_path from core.call_object_deletions d where d.done_at is null
   order by d.requested_at limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

create or replace function api.call_object_deletion_done(p_path text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  -- 아직 살아 있는 녹취 파일은 지운 것으로 기록할 수 없다
  if exists (select 1 from pii.call_recordings r where r.storage_path = p_path) then
    raise exception 'STILL_REFERENCED' using errcode = '42501';
  end if;
  update core.call_object_deletions set done_at = now() where storage_path = p_path and done_at is null;
  return found;
end
$$;

revoke all on function core.calls_guard(), core.call_purge_internal(uuid, uuid, text), core.purge_expired_calls(),
  core.calls_on_lead_purge(), core.calls_on_customer_delete(), core.call_visible(core.staff, uuid) from public;

alter table core.call_settings enable row level security;
alter table core.call_settings force row level security;
alter table core.calls enable row level security;
alter table core.calls force row level security;
alter table pii.call_recordings enable row level security;
alter table pii.call_recordings force row level security;
alter table core.call_object_deletions enable row level security;
alter table core.call_object_deletions force row level security;
alter table core.call_links enable row level security;
alter table core.call_links force row level security;

commit;
