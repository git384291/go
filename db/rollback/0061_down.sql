-- 0061 롤백: 새 함수 제거, create_lead(0007)·recontact_schedule(0060) 이전 정의 복원. 이미 묶인 고객 행은 그대로 둔다.
begin;
drop function if exists api.crm_unhandled(uuid, uuid, text);
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

  -- 1-1) PHASE 1: 상담 대상 상품이 DB 기준으로도 '활성'이어야 한다.
  --      서버 코드(catalog.ts)가 활성으로 판단해 서명했더라도 DB가 예약이면 거부한다(코드·DB 불일치 차단).
  if not exists (select 1 from core.product_catalog pc where pc.product_key = p_interest and pc.status = 'active') then
    raise exception 'PRODUCT_NOT_ACTIVE' using errcode = 'FP001';
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
  -- 필수 고지: 이 문서 버전에 묶인 고지 문구가 DB에 없으면 접수하지 않는다(고지 누락 시 차단)
  if not exists (select 1 from core.notice_texts n where n.version = p_privacy_doc_version) then
    raise exception 'SERVICE_NOT_READY' using errcode = '55000';
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

  -- 같은 요청이 동시에 두 번 들어온 경우(더블 클릭 등): 5)는 잠금 전이라 둘 다 통과할 수 있으므로 잠금 후 다시 확인한다.
  -- 이 확인이 없으면 두 번째 요청이 '재문의'로 잘못 기록된다.
  if exists (select 1 from core.leads l where l.idempotency_key = p_idempotency_key) then
    return 'accepted';
  end if;

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
  -- 필수 고지 노출 기록: 동의와 같은 문서 버전의 고지 문구 전체(문구 해시 포함)를 고객 단위로 남긴다
  insert into pii.notice_exposures (customer_id, doc_version, notice_key, body_sha256, channel)
  select v_customer, n.version, n.notice_key, n.body_sha256, 'web'
  from core.notice_texts n where n.version = p_privacy_doc_version;
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

create or replace function api.recontact_schedule(p_actor uuid, p_session uuid, p_token text, p_lead uuid, p_due_on date, p_channel text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_customer uuid;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_ok text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);   -- MVP: 대표만
  if p_lead is null or p_due_on is null or p_channel is null or p_channel not in ('phone', 'sms', 'alimtalk')
     or p_due_on < v_today or p_due_on > v_today + 90 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('recontact:' || p_lead::text, 0));
  select l.customer_id into v_customer from core.leads l where l.id = p_lead and l.purged_at is null;
  if v_customer is null then
    raise exception 'LEAD_NOT_FOUND' using errcode = '22023';
  end if;
  v_ok := core.recontact_allowed(v_customer, p_channel);
  if v_ok <> 'OK' then
    raise exception '%', v_ok using errcode = '22023';
  end if;
  if exists (select 1 from core.recontact_schedule s where s.lead_id = p_lead and s.due_on = p_due_on and s.status = 'pending') then
    return 'exists';
  end if;
  if (select count(*) from core.recontact_schedule s where s.lead_id = p_lead and s.status = 'pending') >= 3 then
    raise exception 'TOO_MANY_PENDING' using errcode = '22023';
  end if;
  insert into core.recontact_schedule (lead_id, due_on, channel, created_by) values (p_lead, p_due_on, p_channel, v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'recontact.schedule', 'lead', p_lead, jsonb_build_object('due_on', p_due_on, 'channel', p_channel));
  return 'scheduled';
end
$$;
commit;
