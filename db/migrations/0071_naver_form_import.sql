-- 0071_naver_form_import.sql — 네이버 폼 결과를 대표가 CRM으로 안전하게 가져오기
-- 원본 CSV는 서버 메모리에서만 처리한다. DB에는 암호문·검색 HMAC·마스킹 값과 정확한 동의 고지만 남긴다.
begin;

insert into core.notice_texts (version, notice_key, body, body_sha256)
values (
  'naver-form-2026-11-28',
  'collection_use',
  E'수집 및 이용하는 개인정보 항목\n성함, 휴대전화번호, 설치 희망 지역(시·군·구)\n수집 및 이용 목적\n인터넷 가입 접수 확인, 가입 조건 안내 및 연락\n보유 및 이용기간\n접수일로부터 30일 후 파기. 단, 관계 법령에 따라 보존이 필요한 경우 해당 법령에서 정한 기간',
  repeat('0', 64)
)
on conflict (version, notice_key) do nothing;

do $$
begin
  if not exists (
    select 1 from core.notice_texts
     where version = 'naver-form-2026-11-28' and notice_key = 'collection_use'
       and body = E'수집 및 이용하는 개인정보 항목\n성함, 휴대전화번호, 설치 희망 지역(시·군·구)\n수집 및 이용 목적\n인터넷 가입 접수 확인, 가입 조건 안내 및 연락\n보유 및 이용기간\n접수일로부터 30일 후 파기. 단, 관계 법령에 따라 보존이 필요한 경우 해당 법령에서 정한 기간'
  ) then
    raise exception 'NOTICE_VERSION_CONFLICT' using errcode = '55000';
  end if;
end
$$;

-- 폼 고지 버전을 응답시각 구간에 고정한다. 폼 문구를 바꾸면 기존 구간을 닫고 새 버전을 마이그레이션으로 추가한다.
create table core.naver_form_notice_windows (
  doc_version text primary key,
  notice_key text not null default 'collection_use' check (notice_key = 'collection_use'),
  valid_from timestamptz not null,
  valid_until timestamptz,
  check (valid_until is null or valid_until > valid_from),
  foreign key (doc_version, notice_key) references core.notice_texts(version, notice_key)
);
insert into core.naver_form_notice_windows (doc_version, valid_from)
values ('naver-form-2026-11-28', '2026-11-27 00:00:00+09');
alter table core.naver_form_notice_windows enable row level security;
alter table core.naver_form_notice_windows force row level security;
create policy fideon_api_all on core.naver_form_notice_windows to fideon_api using (true) with check (true);

-- 리드 중복 여부와 무관하게 응답 1건당 영수증 1건을 남긴다. 지역은 응답별 암호문으로 보존한다.
create table pii.naver_form_import_receipts (
  idempotency_key text primary key check (idempotency_key ~ '^naver-[0-9a-f]{58}$'),
  customer_id uuid not null references pii.customers(id) on delete cascade,
  lead_id uuid not null references core.leads(id),
  area_enc text not null check (area_enc ~ '^v[0-9]+:'),
  responded_at timestamptz not null,
  doc_version text not null references core.naver_form_notice_windows(doc_version),
  outcome text not null check (outcome in ('imported', 'duplicate')),
  imported_at timestamptz not null default now()
);
create index naver_form_receipts_customer on pii.naver_form_import_receipts(customer_id, responded_at desc);
alter table pii.naver_form_import_receipts enable row level security;
alter table pii.naver_form_import_receipts force row level security;
create policy fideon_api_all on pii.naver_form_import_receipts to fideon_api using (true) with check (true);

create or replace function api.naver_form_import(
  p_actor uuid, p_session uuid, p_token text,
  p_name_enc text, p_name_masked text,
  p_phone_enc text, p_phone_hmac text, p_phone_last4 text,
  p_area_enc text, p_responded_at timestamptz, p_idempotency_key text,
  p_consent_collection boolean, p_doc_version text
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_window int;
  v_customer uuid;
  v_existing uuid;
  v_lead uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);

  if p_consent_collection is distinct from true then
    raise exception 'CONSENT_REQUIRED' using errcode = '22023';
  end if;
  if p_doc_version is distinct from 'naver-form-2026-11-28'
     or not exists (
       select 1 from core.naver_form_notice_windows w
       where w.doc_version = p_doc_version and p_responded_at >= w.valid_from
         and (w.valid_until is null or p_responded_at < w.valid_until)
     ) then
    raise exception 'CONSENT_VERSION_MISMATCH' using errcode = '22023';
  end if;
  if p_responded_at is null or p_responded_at > now() + interval '10 minutes'
     or p_responded_at + interval '30 days' <= now() then
    raise exception 'INVALID_RESPONSE_TIME' using errcode = '22023';
  end if;
  if p_name_enc !~ '^v[0-9]+:' or p_phone_enc !~ '^v[0-9]+:' or p_area_enc !~ '^v[0-9]+:'
     or p_phone_hmac !~ '^[0-9a-f]{64}$' or p_phone_last4 !~ '^[0-9]{4}$'
     or length(p_name_masked) not between 1 and 20
     or p_idempotency_key !~ '^naver-[0-9a-f]{58}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not coalesce((select f.enabled from core.feature_flags f where f.key = 'lead_form'), false)
     or not exists (select 1 from core.product_catalog pc where pc.product_key = 'internet_tv' and pc.status = 'active') then
    raise exception 'SERVICE_NOT_READY' using errcode = '55000';
  end if;
  if exists (select 1 from pii.naver_form_import_receipts r where r.idempotency_key = p_idempotency_key) then return 'already'; end if;
  perform pg_advisory_xact_lock(hashtextextended('naver:' || p_idempotency_key, 0));
  if exists (select 1 from pii.naver_form_import_receipts r where r.idempotency_key = p_idempotency_key) then return 'already'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lead:' || p_phone_hmac, 0));
  if exists (select 1 from pii.naver_form_import_receipts r where r.idempotency_key = p_idempotency_key) then return 'already'; end if;

  select c.id into v_customer from pii.customers c where c.phone_hmac = p_phone_hmac order by c.created_at desc limit 1;
  if v_customer is null then
    insert into pii.customers (name_enc, phone_enc, phone_hmac, address_enc, retention_until)
    values (p_name_enc, p_phone_enc, p_phone_hmac, p_area_enc, p_responded_at + interval '30 days')
    returning id into v_customer;
  else
    update pii.customers c
       set retention_until = greatest(c.retention_until, p_responded_at + interval '30 days'),
           address_enc = p_area_enc
     where c.id = v_customer;
  end if;

  insert into pii.consents (customer_id, kind, doc_version, granted, channel, created_at)
  values (v_customer, 'collection_use', p_doc_version, true, 'web', p_responded_at);
  insert into pii.notice_exposures (customer_id, doc_version, notice_key, body_sha256, channel, shown_at)
  select v_customer, n.version, n.notice_key, n.body_sha256, 'web', p_responded_at
    from core.notice_texts n where n.version = p_doc_version and n.notice_key = 'collection_use';

  v_window := coalesce((select (s.value #>> '{}')::int from core.settings s where s.key = 'duplicate_window_days'), 7);
  select l.id into v_existing
    from core.leads l join pii.customers c on c.id = l.customer_id
   where c.phone_hmac = p_phone_hmac
     and l.created_at between p_responded_at - make_interval(days => v_window)
                          and p_responded_at + make_interval(days => v_window)
   order by l.created_at desc limit 1;
  if v_existing is not null then
    insert into pii.naver_form_import_receipts
      (idempotency_key, customer_id, lead_id, area_enc, responded_at, doc_version, outcome)
    values (p_idempotency_key, v_customer, v_existing, p_area_enc, p_responded_at, p_doc_version, 'duplicate');
    insert into core.lead_status_history (lead_id, from_status, to_status, actor_id, reason)
    select l.id, l.status, l.status, v_staff.user_id, 'naver_form_repeat' from core.leads l where l.id = v_existing;
    insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
    values (v_staff.user_id, 'lead.naver_import', 'lead', v_existing, jsonb_build_object('duplicate', true));
    return 'duplicate';
  end if;

  insert into core.leads (customer_id, name_masked, phone_last4, interest, utm_source, utm_medium, utm_campaign, idempotency_key, created_at)
  values (v_customer, p_name_masked, p_phone_last4, 'internet_tv', 'naver', 'form', 'official-intake', p_idempotency_key, p_responded_at)
  returning id into v_lead;
  insert into pii.naver_form_import_receipts
    (idempotency_key, customer_id, lead_id, area_enc, responded_at, doc_version, outcome)
  values (p_idempotency_key, v_customer, v_lead, p_area_enc, p_responded_at, p_doc_version, 'imported');
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'lead.naver_import', 'lead', v_lead, jsonb_build_object('duplicate', false));
  return 'imported';
end
$$;

alter function api.naver_form_import(uuid, uuid, text, text, text, text, text, text, text, timestamptz, text, boolean, text) owner to fideon_api;
grant select on core.naver_form_notice_windows to fideon_api;
grant select, insert on pii.naver_form_import_receipts to fideon_api;
-- 생성 직후 PostgreSQL 기본 PUBLIC EXECUTE를 제거하고 운영 증분 적용에서도 app_staff만 다시 연다.
do $$
declare r text;
begin
  revoke all on function api.naver_form_import(uuid, uuid, text, text, text, text, text, text, text, timestamptz, text, boolean, text) from public;
  foreach r in array array['anon', 'authenticated', 'app_public', 'app_staff', 'app_server', 'app_ai', 'app_ad_monitor', 'app_ad_scheduler', 'app_call', 'release_auditor'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function api.naver_form_import(uuid,uuid,text,text,text,text,text,text,text,timestamptz,text,boolean,text) from %I', r);
    end if;
  end loop;
end
$$;
grant execute on function api.naver_form_import(uuid, uuid, text, text, text, text, text, text, text, timestamptz, text, boolean, text) to app_staff;
commit;
