-- 0004_product_scope.sql
-- FIDEON PM PHASE 1: 상품 활성 상태 + 활성화 2인 승인 검증
--
-- 원칙
--   - 기존 마이그레이션(0001~0003, zz_grants)은 수정하지 않는다. 이 파일은 추가만 한다.
--   - 활성 상품은 인터넷+TV 하나. 나머지는 예약(reserved).
--   - 예약 → 활성 전환은 사용자(owner 역할)와 PM(reviewer 역할) 두 사람의 승인이 모두 있어야 하며,
--     각 승인은 서버 서명 키로 만든 '승인 전용' 서명(상품·승인 종류·승인자·세션에 묶임)으로만 기록된다.
--     승인자 ID만 적어 넣는 방식으로는 승인 기록을 만들 수 없다.
--   - 승인은 1회용이고 7일이 지나면 쓸 수 없다. 활성화에 쓰이면 소진 처리된다.
--   - 이번 단계에서는 승인·활성화를 호출하는 api 함수를 만들지 않는다(앱 역할은 이 테이블·함수에 접근 불가).
--   - api.create_lead는 DB 기준 상품 상태를 다시 확인한다(서버 코드와 DB 중 한쪽만 예약이어도 차단).
-- 동판: 정의 미확정으로 키를 만들지 않는다.
begin;

-- 1) 상품 상태 ------------------------------------------------------------------
create table core.product_catalog (
  product_key  text primary key
               check (product_key in ('internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other', 'mobile')),
  label        text not null check (length(label) between 1 and 40),
  status       text not null check (status in ('active', 'reserved')),
  activated_at timestamptz,
  updated_at   timestamptz not null default now(),
  check ((status = 'active') = (activated_at is not null))
);

-- 기준값. src/content/catalog.ts와 같아야 한다(tests/unit/catalog.test.ts가 이 줄들을 읽어 대조).
-- 보호 트리거를 만들기 전에 넣는다. 트리거 생성 이후에는 '활성' 행을 새로 넣을 수 없다.
insert into core.product_catalog (product_key, label, status, activated_at) values
  ('internet_tv',    '인터넷 + TV',     'active',   now()),
  ('internet_phone', '인터넷 + 집전화', 'reserved', null),
  ('internet_only',  '인터넷만',        'reserved', null),
  ('cctv_security',  'CCTV · 보안',     'reserved', null),
  ('other',          '잘 모르겠어요',   'reserved', null),
  ('mobile',         '휴대폰',          'reserved', null);

-- 2) 활성화 승인 기록(추가 전용) ---------------------------------------------------
create table core.product_activation_approvals (
  id            uuid primary key default gen_random_uuid(),
  product_key   text not null references core.product_catalog(product_key),
  approval_kind text not null check (approval_kind in ('owner', 'pm')),   -- owner = 사용자(대표), pm = PM 검수자
  staff_id      uuid not null references core.staff(user_id),
  session_id    uuid not null references security.staff_sessions(id),
  reason        text not null check (length(btrim(reason)) between 2 and 500),
  proof         text,             -- 기록 시 검증용 서명. 검증 후 저장하지 않는다(트리거가 null로 비움)
  created_at    timestamptz not null default now(),
  consumed_at   timestamptz
);
create index product_approvals_open on core.product_activation_approvals (product_key, approval_kind) where consumed_at is null;

-- 승인 기록 보호: 서명 검증 · 역할 확인 · 수정/삭제 금지
create or replace function core.product_approval_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_need text;
begin
  if tg_op = 'DELETE' then
    raise exception 'APPROVAL_IMMUTABLE' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    -- 허용되는 변경은 '소진 표시' 하나뿐(되돌리기·내용 변경 불가)
    if old.consumed_at is null and new.consumed_at is not null
       and (new.id, new.product_key, new.approval_kind, new.staff_id, new.session_id, new.reason, new.created_at)
           is not distinct from
           (old.id, old.product_key, old.approval_kind, old.staff_id, old.session_id, old.reason, old.created_at)
       and new.proof is null then
      new.consumed_at := now();
      return new;
    end if;
    raise exception 'APPROVAL_IMMUTABLE' using errcode = '42501';
  end if;

  -- INSERT: 승인 전용 서명 확인. 서명 대상에 상품·승인 종류·승인자·세션이 모두 들어가므로
  -- 다른 상품·다른 종류·다른 사람 명의로 재사용할 수 없다.
  if new.proof is null
     or not security.verify_token('staff', new.proof, array[
          'product-approve', new.staff_id::text, new.session_id::text, new.product_key, new.approval_kind]) then
    raise exception 'APPROVAL_PROOF_INVALID' using errcode = '42501';
  end if;

  -- 승인자 역할: 사용자 승인은 owner, PM 승인은 reviewer. 유효한(만료·폐기되지 않은) 본인 세션이어야 한다.
  select st.role into v_role
  from security.staff_sessions s
  join core.staff st on st.user_id = s.user_id
  where s.id = new.session_id
    and s.user_id = new.staff_id
    and s.revoked_at is null
    and s.created_at > now() - interval '12 hours'
    and st.active;
  v_need := case new.approval_kind when 'owner' then 'owner' when 'pm' then 'reviewer' end;
  if v_role is null or v_need is null or v_role <> v_need then
    raise exception 'APPROVER_ROLE_INVALID' using errcode = '42501';
  end if;

  if not exists (select 1 from core.product_catalog pc where pc.product_key = new.product_key and pc.status = 'reserved') then
    raise exception 'PRODUCT_NOT_RESERVED' using errcode = '22023';
  end if;

  new.proof       := null;     -- 서명은 저장하지 않는다
  new.created_at  := now();    -- 승인 시각은 DB가 정한다(과거·미래 날짜 입력 불가)
  new.consumed_at := null;
  insert into core.audit_logs (actor_id, action, target_type, reason, detail)
  values (new.staff_id, 'product.approve', 'product', new.reason,
          jsonb_build_object('product', new.product_key, 'kind', new.approval_kind, 'approval_id', new.id));
  return new;
end
$$;

create trigger product_approval_guard
  before insert or update or delete on core.product_activation_approvals
  for each row execute function core.product_approval_guard();

-- 3) 상품 상태 보호: 2인 승인 없이 활성화 금지 ------------------------------------------
create or replace function core.product_catalog_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_pm    uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'PRODUCT_CATALOG_IMMUTABLE' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    -- 기준값 이후 새 상품은 예약 상태로만 추가할 수 있다
    if new.status <> 'reserved' or new.activated_at is not null then
      raise exception 'PRODUCT_ACTIVATION_REQUIRES_APPROVAL' using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.product_key is distinct from old.product_key then
    raise exception 'PRODUCT_CATALOG_IMMUTABLE' using errcode = '42501';
  end if;

  if old.status = 'reserved' and new.status = 'active' then
    -- 유효한(미소진, 7일 이내, 승인자가 지금도 활성이고 역할이 맞는) 사용자 승인과 PM 승인이 각각 있어야 한다
    select a.staff_id into v_owner
    from core.product_activation_approvals a join core.staff st on st.user_id = a.staff_id
    where a.product_key = new.product_key and a.approval_kind = 'owner' and a.consumed_at is null
      and a.created_at > now() - interval '7 days' and st.active and st.role = 'owner'
    order by a.created_at desc limit 1;
    select a.staff_id into v_pm
    from core.product_activation_approvals a join core.staff st on st.user_id = a.staff_id
    where a.product_key = new.product_key and a.approval_kind = 'pm' and a.consumed_at is null
      and a.created_at > now() - interval '7 days' and st.active and st.role = 'reviewer'
    order by a.created_at desc limit 1;
    if v_owner is null or v_pm is null or v_owner = v_pm then
      raise exception 'PRODUCT_ACTIVATION_REQUIRES_APPROVAL' using errcode = '42501';
    end if;

    update core.product_activation_approvals
       set consumed_at = now()
     where product_key = new.product_key and consumed_at is null;

    new.activated_at := now();
    new.updated_at   := now();
    insert into core.audit_logs (actor_id, action, target_type, detail)
    values (null, 'product.activate', 'product',
            jsonb_build_object('product', new.product_key, 'owner_approver', v_owner, 'pm_approver', v_pm));
    return new;
  end if;

  if old.status = 'active' and new.status = 'reserved' then
    -- 비활성화(안전한 방향)는 승인 없이 가능. 남아 있는 승인도 함께 무효화한다
    update core.product_activation_approvals
       set consumed_at = now()
     where product_key = new.product_key and consumed_at is null;
    new.activated_at := null;
    new.updated_at   := now();
    insert into core.audit_logs (action, target_type, detail)
    values ('product.reserve', 'product', jsonb_build_object('product', new.product_key));
    return new;
  end if;

  -- 상태 변화 없는 수정(표시 이름 등): 활성 시각은 바꿀 수 없다
  if new.activated_at is distinct from old.activated_at then
    raise exception 'PRODUCT_CATALOG_IMMUTABLE' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger product_catalog_guard
  before insert or update or delete on core.product_catalog
  for each row execute function core.product_catalog_guard();

-- TRUNCATE는 행 트리거를 거치지 않으므로 별도로 막는다
create or replace function core.block_truncate()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'TRUNCATE_NOT_ALLOWED on %.%', tg_table_schema, tg_table_name using errcode = '42501';
end
$$;
create trigger product_catalog_no_truncate before truncate on core.product_catalog
  for each statement execute function core.block_truncate();
create trigger product_approvals_no_truncate before truncate on core.product_activation_approvals
  for each statement execute function core.block_truncate();

-- 새 함수는 어떤 앱 역할에도 실행 권한을 주지 않는다(트리거로만 동작). zz_grants도 core 함수 권한을 회수한다.
revoke all on function core.product_approval_guard(), core.product_catalog_guard(), core.block_truncate() from public;

-- 새 테이블도 RLS 적용(zz_grants가 다시 실행되며 fideon_api 정책을 붙인다)
alter table core.product_catalog enable row level security;
alter table core.product_catalog force row level security;
alter table core.product_activation_approvals enable row level security;
alter table core.product_activation_approvals force row level security;

-- 4) 상담 신청 함수 교체: DB 기준 상품 상태 확인 추가 ----------------------------------
--    0002의 본문을 그대로 두고 '1-1)' 블록만 추가했다. 인자·반환형·서명 필드는 같으므로 권한(zz_grants)도 그대로다.
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

commit;
