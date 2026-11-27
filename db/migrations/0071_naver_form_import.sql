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

create or replace function api.naver_form_import(
  p_actor uuid, p_session uuid, p_token text,
  p_name_enc text, p_name_masked text,
  p_phone_enc text, p_phone_hmac text, p_phone_last4 text,
  p_area_enc text, p_idempotency_key text,
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
     or not exists (select 1 from core.notice_texts n where n.version = p_doc_version and n.notice_key = 'collection_use') then
    raise exception 'CONSENT_VERSION_MISMATCH' using errcode = '22023';
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
  if exists (select 1 from core.leads l where l.idempotency_key = p_idempotency_key) then return 'already'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lead:' || p_phone_hmac, 0));
  if exists (select 1 from core.leads l where l.idempotency_key = p_idempotency_key) then return 'already'; end if;

  select c.id into v_customer from pii.customers c where c.phone_hmac = p_phone_hmac order by c.created_at desc limit 1;
  if v_customer is null then
    insert into pii.customers (name_enc, phone_enc, phone_hmac, address_enc, retention_until)
    values (p_name_enc, p_phone_enc, p_phone_hmac, p_area_enc, now() + interval '30 days')
    returning id into v_customer;
  else
    update pii.customers c
       set retention_until = greatest(c.retention_until, now() + interval '30 days'),
           address_enc = coalesce(c.address_enc, p_area_enc)
     where c.id = v_customer;
  end if;

  insert into pii.consents (customer_id, kind, doc_version, granted, channel)
  values (v_customer, 'collection_use', p_doc_version, true, 'web');
  insert into pii.notice_exposures (customer_id, doc_version, notice_key, body_sha256, channel)
  select v_customer, n.version, n.notice_key, n.body_sha256, 'web'
    from core.notice_texts n where n.version = p_doc_version and n.notice_key = 'collection_use';

  v_window := coalesce((select (s.value #>> '{}')::int from core.settings s where s.key = 'duplicate_window_days'), 7);
  select l.id into v_existing
    from core.leads l join pii.customers c on c.id = l.customer_id
   where c.phone_hmac = p_phone_hmac and l.created_at > now() - make_interval(days => v_window)
   order by l.created_at desc limit 1;
  if v_existing is not null then
    insert into core.lead_status_history (lead_id, from_status, to_status, actor_id, reason)
    select l.id, l.status, l.status, v_staff.user_id, 'naver_form_repeat' from core.leads l where l.id = v_existing;
    insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
    values (v_staff.user_id, 'lead.naver_import', 'lead', v_existing, jsonb_build_object('duplicate', true));
    return 'duplicate';
  end if;

  insert into core.leads (customer_id, name_masked, phone_last4, interest, utm_source, utm_medium, utm_campaign, idempotency_key)
  values (v_customer, p_name_masked, p_phone_last4, 'internet_tv', 'naver', 'form', 'official-intake', p_idempotency_key)
  returning id into v_lead;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'lead.naver_import', 'lead', v_lead, jsonb_build_object('duplicate', false));
  return 'imported';
end
$$;

alter function api.naver_form_import(uuid, uuid, text, text, text, text, text, text, text, text, boolean, text) owner to fideon_api;
-- 생성 직후 PostgreSQL 기본 PUBLIC EXECUTE를 제거한다. zz_grants.sql이 app_staff에만 다시 연다.
do $$
declare r text;
begin
  revoke all on function api.naver_form_import(uuid, uuid, text, text, text, text, text, text, text, text, boolean, text) from public;
  foreach r in array array['anon', 'authenticated', 'app_public', 'app_staff', 'app_server', 'app_ai', 'app_ad_monitor', 'app_ad_scheduler', 'app_call', 'release_auditor'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function api.naver_form_import(uuid,uuid,text,text,text,text,text,text,text,text,boolean,text) from %I', r);
    end if;
  end loop;
end
$$;
commit;
