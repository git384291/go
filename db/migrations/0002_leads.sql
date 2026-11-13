-- 0002_leads.sql
-- 상담 신청(리드), 개인정보 암호문, 동의, 관리자 함수
-- REV-004 SEC-02: 암호문·HMAC·동의는 서버가 만들고 서명한 값만 저장, 리드 ID 비노출
begin;

create table core.settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references core.staff(user_id),
  updated_at timestamptz not null default now()
);

create table core.feature_flags (
  key             text primary key
                  check (key in ('lead_form', 'notify_live', 'ai_chat', 'online_application', 'policy_publish')),
  enabled         boolean not null default false,
  disabled_reason text,
  updated_by      uuid references core.staff(user_id),
  updated_at      timestamptz not null default now()
);
insert into core.feature_flags (key) values
  ('lead_form'), ('notify_live'), ('ai_chat'), ('online_application'), ('policy_publish');

create table pii.customers (
  id              uuid primary key default gen_random_uuid(),
  name_enc        text not null check (name_enc ~ '^v[0-9]+:'),
  phone_enc       text not null check (phone_enc ~ '^v[0-9]+:'),
  phone_hmac      text not null check (phone_hmac ~ '^[0-9a-f]{64}$'),
  address_enc     text check (address_enc is null or address_enc ~ '^v[0-9]+:'),
  created_at      timestamptz not null default now(),
  retention_until timestamptz not null
);
create index customers_phone_hmac on pii.customers (phone_hmac);

create table pii.consents (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references pii.customers(id) on delete cascade,
  kind        text not null check (kind in ('collection_use', 'third_party', 'overseas_transfer')),
  doc_version text not null,
  granted     boolean not null,
  channel     text not null check (channel in ('web', 'phone')),
  created_at  timestamptz not null default now()
);

create table pii.marketing_consents (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references pii.customers(id) on delete cascade,
  event       text not null check (event in ('opt_in', 'opt_out', 'reconfirm')),
  channel     text not null check (channel in ('sms', 'alimtalk', 'phone')),
  doc_version text,
  created_at  timestamptz not null default now()
);

create table core.leads (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid references pii.customers(id) on delete set null,
  name_masked     text not null check (length(name_masked) between 1 and 20),
  phone_last4     text not null check (phone_last4 ~ '^[0-9]{4}$'),
  interest        text not null check (interest in ('internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other')),
  contact_time    text check (length(contact_time) <= 50),
  utm_source      text check (length(utm_source) <= 100),
  utm_medium      text check (length(utm_medium) <= 100),
  utm_campaign    text check (length(utm_campaign) <= 100),
  status          text not null default 'new'
                  check (status in ('new', 'contacting', 'consulted', 'no_answer', 'declined', 'converted')),
  assigned_to     uuid references core.staff(user_id),
  idempotency_key text not null unique check (length(idempotency_key) between 16 and 64),
  purged_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index leads_assigned on core.leads (assigned_to, created_at desc);
create index leads_customer on core.leads (customer_id);

create table core.lead_status_history (
  id          bigint generated always as identity primary key,
  lead_id     uuid not null references core.leads(id),
  from_status text not null,
  to_status   text not null,
  actor_id    uuid,
  reason      text,
  at          timestamptz not null default now()
);

create table core.lead_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references core.leads(id),
  author_id  uuid not null references core.staff(user_id),
  body       text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- 상담 신청 (공개)
-- 반환값은 항상 'accepted'. 신규·중복 여부와 리드 ID를 밖으로 알리지 않는다.
create or replace function api.create_lead(
  p_token text,
  p_name_enc text, p_name_masked text, p_phone_enc text, p_phone_hmac text, p_phone_last4 text,
  p_interest text, p_contact_time text,
  p_utm_source text, p_utm_medium text, p_utm_campaign text,
  p_idempotency_key text, p_privacy_doc_version text,
  p_consent_collection boolean, p_marketing_opt_in boolean, p_ip_hash text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_retention_days  int;
  v_privacy_version text;
  v_window          int;
  v_existing        uuid;
  v_customer        uuid;
  v_lead            uuid;
begin
  -- 1) 신뢰할 수 있는 서버가 만든 값인지: 모든 필드에 대한 서버 서명 확인
  if not security.verify_token('lead', p_token, array[
       p_name_enc, p_name_masked, p_phone_enc, p_phone_hmac, p_phone_last4,
       p_interest, p_contact_time, p_utm_source, p_utm_medium, p_utm_campaign,
       p_idempotency_key, p_privacy_doc_version,
       p_consent_collection::text, p_marketing_opt_in::text, p_ip_hash]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  -- 2) 운영 준비 상태: 스위치 + 처리방침 버전 + 보유기간이 모두 있어야 한다
  if not coalesce((select f.enabled from core.feature_flags f where f.key = 'lead_form'), false) then
    raise exception 'SERVICE_NOT_READY' using errcode = '55000';
  end if;
  v_retention_days  := (select (s.value #>> '{}')::int from core.settings s where s.key = 'lead_retention_days');
  v_privacy_version := (select s.value #>> '{}' from core.settings s where s.key = 'privacy_policy_version');
  if v_retention_days is null or v_privacy_version is null then
    raise exception 'SERVICE_NOT_READY' using errcode = '55000';
  end if;

  -- 3) 동의: 서버 검증 결과를 DB에서 다시 확인
  if p_consent_collection is distinct from true then
    raise exception 'CONSENT_REQUIRED' using errcode = '22023';
  end if;
  if p_privacy_doc_version is distinct from v_privacy_version then
    raise exception 'CONSENT_VERSION_MISMATCH' using errcode = '22023';
  end if;

  -- 4) 형식
  if p_phone_hmac !~ '^[0-9a-f]{64}$' or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_name_enc !~ '^v[0-9]+:' or p_phone_enc !~ '^v[0-9]+:'
     or p_phone_last4 !~ '^[0-9]{4}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- 5) 같은 요청 재전송
  if exists (select 1 from core.leads l where l.idempotency_key = p_idempotency_key) then
    return 'accepted';
  end if;

  -- 6) IP(해시)당 시간당 10건. 같은 IP의 동시 요청이 서로의 기록을 못 본 채 통과하지 않도록 먼저 잠근다
  perform pg_advisory_xact_lock(hashtextextended('ip:' || p_ip_hash, 0));
  if (select count(*) from core.audit_logs a
       where a.action = 'lead.create' and a.at > now() - interval '1 hour'
         and a.detail->>'ip_hash' = p_ip_hash) >= 10 then
    raise exception 'RATE_LIMITED' using errcode = '54000';
  end if;

  -- 7) 같은 연락처의 동시 신청 직렬화 후 중복 판정
  perform pg_advisory_xact_lock(hashtextextended('lead:' || p_phone_hmac, 0));

  v_window := coalesce((select (s.value #>> '{}')::int from core.settings s where s.key = 'duplicate_window_days'), 7);
  select l.id into v_existing
  from core.leads l join pii.customers c on c.id = l.customer_id
  where c.phone_hmac = p_phone_hmac and l.created_at > now() - make_interval(days => v_window)
  order by l.created_at desc
  limit 1;

  if v_existing is not null then
    insert into core.lead_status_history (lead_id, from_status, to_status, reason)
    select l.id, l.status, l.status, 'repeat_inquiry' from core.leads l where l.id = v_existing;
    insert into core.audit_logs (action, target_type, target_id, detail)
    values ('lead.create', 'lead', v_existing, jsonb_build_object('ip_hash', p_ip_hash, 'duplicate', true));
    return 'accepted';
  end if;

  insert into pii.customers (name_enc, phone_enc, phone_hmac, retention_until)
  values (p_name_enc, p_phone_enc, p_phone_hmac, now() + make_interval(days => v_retention_days))
  returning id into v_customer;

  insert into pii.consents (customer_id, kind, doc_version, granted, channel)
  values (v_customer, 'collection_use', p_privacy_doc_version, true, 'web');
  if p_marketing_opt_in then
    insert into pii.marketing_consents (customer_id, event, channel, doc_version)
    values (v_customer, 'opt_in', 'sms', p_privacy_doc_version);
  end if;

  insert into core.leads (customer_id, name_masked, phone_last4, interest, contact_time,
                          utm_source, utm_medium, utm_campaign, idempotency_key)
  values (v_customer, p_name_masked, p_phone_last4, p_interest, nullif(p_contact_time, ''),
          nullif(p_utm_source, ''), nullif(p_utm_medium, ''), nullif(p_utm_campaign, ''), p_idempotency_key)
  returning id into v_lead;

  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('lead.create', 'lead', v_lead, jsonb_build_object('ip_hash', p_ip_hash));
  return 'accepted';
end
$$;

create or replace function api.list_leads(p_actor uuid, p_session uuid, p_token text, p_limit int, p_offset int)
returns table (lead_id uuid, created_at timestamptz, name_masked text, phone_masked text, interest text,
               contact_time text, status text, assigned_to uuid, utm_source text)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor', 'reviewer']);
  return query
    select l.id, l.created_at, l.name_masked, '010-****-' || l.phone_last4, l.interest,
           l.contact_time, l.status, l.assigned_to, l.utm_source
    from core.leads l
    where v_staff.role in ('owner', 'reviewer') or l.assigned_to = v_staff.user_id
    order by l.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end
$$;

create or replace function api.reveal_contact(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_reason text)
returns table (name_enc text, phone_enc text, address_enc text)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff    core.staff;
  v_customer uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor']);
  if length(btrim(coalesce(p_reason, ''))) < 2 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if (select count(*) from core.audit_logs a
       where a.actor_id = v_staff.user_id and a.action = 'pii.reveal' and a.at > now() - interval '1 hour') >= 30 then
    raise exception 'REVEAL_RATE_LIMITED' using errcode = '54000';
  end if;

  select l.customer_id into v_customer
  from core.leads l
  where l.id = p_lead_id
    and l.customer_id is not null
    and (v_staff.role = 'owner' or l.assigned_to = v_staff.user_id);
  if v_customer is null then
    raise exception 'FORBIDDEN' using errcode = '42501';   -- 없음·권한 없음·파기됨을 구분하지 않는다
  end if;

  insert into core.audit_logs (actor_id, action, target_type, target_id, reason)
  values (v_staff.user_id, 'pii.reveal', 'lead', p_lead_id, p_reason);

  return query select c.name_enc, c.phone_enc, c.address_enc from pii.customers c where c.id = v_customer;
end
$$;

create or replace function api.update_lead(p_actor uuid, p_session uuid, p_token text,
                                           p_lead_id uuid, p_status text, p_note text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_lead  core.leads;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor']);
  select * into v_lead from core.leads l
   where l.id = p_lead_id and (v_staff.role = 'owner' or l.assigned_to = v_staff.user_id)
   for update;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_status is not null and p_status <> v_lead.status then
    if not ((v_lead.status, p_status) in (
          ('new', 'contacting'), ('contacting', 'consulted'), ('contacting', 'no_answer'),
          ('contacting', 'declined'), ('no_answer', 'contacting'), ('consulted', 'converted'))) then
      raise exception 'INVALID_TRANSITION' using errcode = '22023';
    end if;
    update core.leads set status = p_status, updated_at = now() where id = p_lead_id;
    insert into core.lead_status_history (lead_id, from_status, to_status, actor_id)
    values (p_lead_id, v_lead.status, p_status, v_staff.user_id);
  end if;

  if p_note is not null and length(btrim(p_note)) > 0 then
    insert into core.lead_notes (lead_id, author_id, body) values (p_lead_id, v_staff.user_id, btrim(p_note));
  end if;
end
$$;

create or replace function api.assign_lead(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_counselor uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if not exists (select 1 from core.staff s where s.user_id = p_counselor and s.active and s.role in ('owner', 'counselor')) then
    raise exception 'INVALID_ASSIGNEE' using errcode = '22023';
  end if;
  update core.leads set assigned_to = p_counselor, updated_at = now() where id = p_lead_id;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'lead.assign', 'lead', p_lead_id, jsonb_build_object('assignee', p_counselor));
end
$$;

create or replace function api.export_leads_masked(p_actor uuid, p_session uuid, p_token text, p_from date, p_to date)
returns table (created_at timestamptz, name_masked text, phone_masked text, interest text, status text, utm_source text)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_count int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'INVALID_RANGE' using errcode = '22023';
  end if;
  select count(*) into v_count from core.leads l where l.created_at >= p_from and l.created_at < p_to + 1;
  insert into core.audit_logs (actor_id, action, target_type, detail)
  values (v_staff.user_id, 'lead.export', 'lead',
          jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_count, 'masked', true));
  return query
    select l.created_at, l.name_masked, '010-****-' || l.phone_last4, l.interest, l.status, l.utm_source
    from core.leads l
    where l.created_at >= p_from and l.created_at < p_to + 1
    order by l.created_at;
end
$$;

create or replace function api.set_feature_flag(p_actor uuid, p_session uuid, p_token text,
                                                p_key text, p_enabled boolean, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 2 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  update core.feature_flags
     set enabled = p_enabled,
         disabled_reason = case when p_enabled then null else 'operator' end,
         updated_by = v_staff.user_id, updated_at = now()
   where key = p_key;
  if not found then
    raise exception 'UNKNOWN_FLAG' using errcode = '22023';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, reason, detail)
  values (v_staff.user_id, 'flag.set', 'feature_flag', p_reason, jsonb_build_object('key', p_key, 'enabled', p_enabled));
end
$$;

-- 파기: 암호문 삭제(동의 연쇄 삭제), 리드는 통계용으로 익명화
create or replace function core.purge_customer_internal(p_lead_id uuid, p_actor uuid, p_reason text)
returns void
language plpgsql set search_path = '' as $$
declare
  v_customer uuid;
begin
  select l.customer_id into v_customer from core.leads l where l.id = p_lead_id for update;
  if v_customer is null then
    return;
  end if;
  update core.leads
     set customer_id = null, name_masked = '파기됨', phone_last4 = '0000',
         contact_time = null, purged_at = now(), updated_at = now()
   where customer_id = v_customer;
  delete from pii.customers where id = v_customer;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason)
  values (p_actor, 'pii.purge', 'lead', p_lead_id, p_reason);
end
$$;

create or replace function api.purge_customer(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from core.leads l where l.id = p_lead_id and l.customer_id is not null) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform core.purge_customer_internal(p_lead_id, v_staff.user_id, p_reason);
end
$$;

-- 보유기간 만료 파기(예약 작업 전용, 앱 역할 실행 불가)
create or replace function core.purge_expired() returns int
language plpgsql set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select l.id from core.leads l join pii.customers c on c.id = l.customer_id
    where c.retention_until < now() and l.status <> 'converted'
    limit 1000
  loop
    perform core.purge_customer_internal(r.id, null, 'retention_expired');
    n := n + 1;
  end loop;
  return n;
end
$$;

commit;
