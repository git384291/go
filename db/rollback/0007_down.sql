-- 0007 롤백: api.create_lead를 0004 정의로 되돌리고 필수 고지 테이블을 삭제한다. 접수·동의 등 기존 데이터는 건드리지 않는다.
-- 고지 문구와 고객별 노출 기록은 삭제 전에 보관 테이블로 옮긴다(삭제하지 않고 보존, PM 11/21 6항).
--   core.notice_texts_rollback_archive, pii.notice_exposures_rollback_archive (FK 없는 복사본)
--   이미 보관 테이블이 있으면 이 스크립트는 실패한다(이전 보관본을 덮어쓰지 않는다). 먼저 0007_restore.sql로 복구하거나 보관본 이름을 바꾼다.
-- 복구: 0007을 다시 적용한 뒤 db/rollback/0007_restore.sql 실행(고객이 이미 파기된 노출 기록은 건너뛰고 건수를 알려 준다).
-- 롤백 시 db/audit/catalog_audit.sql의 create_lead 고정 해시도 이전 값(a99eddfc…)으로 되돌리고, 마지막에 zz_grants.sql을 다시 실행한다.
-- 보관 테이블에는 고객 식별자(customer_id)가 들어 있다. 보존기간이 지나면 고객 파기 절차와 같은 기준으로 삭제한다.
begin;

create table core.notice_texts_rollback_archive as table core.notice_texts;
create table pii.notice_exposures_rollback_archive as table pii.notice_exposures;

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

drop table pii.notice_exposures;
drop table core.notice_texts;
drop function if exists core.notice_texts_guard();

commit;
