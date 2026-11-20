-- 0008_policy_store.sql — 정책표 저장소: 초안 → 제출 → 승인(교체) → 게시 (PM 11/21, 설계: docs/design/POLICY-REVIEW-STORE.md)
-- 원칙
--   - 정책 내용(terms·시각·라벨·구분값)은 한 번 쓰면 바꿀 수 없다. 바뀌는 것은 상태 전이뿐이고, 트리거가 허용 전이만 통과시킨다. 삭제 불가.
--   - 쓰기는 모두 SECURITY DEFINER api.policy_* 함수(직원 서명 + DB 세션 + 역할). 승인·반려는 owner만.
--   - 승인은 같은 키의 기존 승인본을 교체(superseded)한다. 같은 키에 승인본은 최대 1개(부분 유니크 인덱스).
--   - '게시'는 승인과 별개: 기능 스위치 policy_publish가 꺼져 있으면 api.policy_published()는 아무것도 돌려주지 않는다(기본 꺼짐).
--   - 수수료·정산 정보는 이 저장소에 두지 않는다(api 함수는 수수료를 읽지 않는다는 기존 규칙 F3). 게시 결과의 내부 필드는 서버가 비워서 채운다.
-- 롤백: db/rollback/0008_down.sql (정책 데이터는 보관 테이블로 옮긴 뒤 삭제)
begin;

create or replace function core.policy_terms_shape(t jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(t) = 'object'
     and length(t::text) <= 8000
     and (select count(*) from jsonb_object_keys(t)) = 7
     and t ?& array['monthlyFee', 'contractMonths', 'equipmentMonthlyFee', 'installFee',
                    'bundlePrerequisites', 'regionScope', 'customerBenefit']
     and not exists (
       select 1 from jsonb_each(t) e
       where jsonb_typeof(e.value) <> 'object'
          or jsonb_typeof(e.value -> 'known') is distinct from 'boolean'
          or ((e.value ->> 'known')::boolean and not (e.value ? 'value')))
$$;

create table core.policy_versions (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     text not null check (supplier_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  segment         text not null check (segment in ('household', 'soho', 'sme')),
  carrier         text not null check (carrier ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  product_id      text not null check (product_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  category        text not null references core.product_catalog (product_key),
  policy_key      text generated always as (supplier_id || '|' || segment || '|' || carrier || '|' || product_id) stored,
  revision        int  not null check (revision >= 1),
  state           text not null check (state in ('draft', 'submitted', 'approved', 'rejected', 'superseded')),
  source_kind     text not null check (source_kind in ('official_policy_sheet', 'distributor_notice', 'training_material', 'past_promotion', 'unverified_screenshot')),
  confirmed_at    timestamptz,
  valid_from      timestamptz not null,
  valid_until     timestamptz,
  product_label   text not null check (length(product_label) between 1 and 80),
  terms           jsonb not null check (core.policy_terms_shape(terms)),
  content_hash    text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_reason text check (decision_reason is null or length(decision_reason) between 2 and 500),
  self_approval   boolean,
  checks          jsonb,
  superseded_at   timestamptz,
  unique (policy_key, revision),
  check (valid_until is null or valid_until > valid_from)
);
create unique index policy_versions_one_approved on core.policy_versions (policy_key) where state = 'approved';
create index policy_versions_state on core.policy_versions (state, valid_from);

create or replace function core.policy_versions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'POLICY_IMMUTABLE' using errcode = '42501';
  end if;
  -- 내용 열은 어떤 전이에서도 바뀌지 않는다
  if (new.supplier_id, new.segment, new.carrier, new.product_id, new.category, new.revision, new.source_kind,
      new.confirmed_at, new.valid_from, new.valid_until, new.product_label, new.terms, new.content_hash,
      new.created_by, new.created_at)
     is distinct from
     (old.supplier_id, old.segment, old.carrier, old.product_id, old.category, old.revision, old.source_kind,
      old.confirmed_at, old.valid_from, old.valid_until, old.product_label, old.terms, old.content_hash,
      old.created_by, old.created_at) then
    raise exception 'POLICY_IMMUTABLE' using errcode = '42501';
  end if;
  if not ((old.state, new.state) in (('draft', 'submitted'), ('submitted', 'approved'), ('submitted', 'rejected'), ('approved', 'superseded'))) then
    raise exception 'INVALID_TRANSITION' using errcode = '22023';
  end if;
  return new;
end
$$;
create trigger policy_versions_guard before update or delete on core.policy_versions
  for each row execute function core.policy_versions_guard();

-- 초안 작성: owner, policy_editor. 항상 새 revision(수정은 새 초안으로 한다)
create or replace function api.policy_create_draft(
  p_actor uuid, p_session uuid, p_token text,
  p_supplier text, p_segment text, p_carrier text, p_product text, p_category text, p_source_kind text,
  p_confirmed_at timestamptz, p_valid_from timestamptz, p_valid_until timestamptz,
  p_label text, p_terms jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_key   text := p_supplier || '|' || p_segment || '|' || p_carrier || '|' || p_product;
  v_rev   int;
  v_id    uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'policy_editor']);
  if not exists (select 1 from core.product_catalog c where c.product_key = p_category and c.status = 'active') then
    raise exception 'PRODUCT_NOT_ACTIVE' using errcode = 'FP001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('policy:' || v_key, 0));
  select coalesce(max(v.revision), 0) + 1 into v_rev from core.policy_versions v where v.policy_key = v_key;
  insert into core.policy_versions (supplier_id, segment, carrier, product_id, category, revision, state, source_kind,
                                    confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by)
  values (p_supplier, p_segment, p_carrier, p_product, p_category, v_rev, 'draft', p_source_kind,
          p_confirmed_at, p_valid_from, p_valid_until, p_label, p_terms,
          encode(sha256(convert_to(concat_ws('|', v_key, p_category, p_source_kind, p_confirmed_at::text, p_valid_from::text,
                                             coalesce(p_valid_until::text, ''), p_label, p_terms::text), 'UTF8')), 'hex'),
          v_staff.user_id)
  returning id into v_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'policy.draft', 'policy_version', v_id, jsonb_build_object('policy_key', v_key, 'revision', v_rev));
  return v_id;
end
$$;

create or replace function api.policy_submit(p_actor uuid, p_session uuid, p_token text, p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row   core.policy_versions;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'policy_editor']);
  select * into v_row from core.policy_versions v where v.id = p_id for update;
  if not found or v_row.state <> 'draft' or (v_row.created_by <> v_staff.user_id and v_staff.role <> 'owner') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update core.policy_versions set state = 'submitted', submitted_at = now() where id = p_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'policy.submit', 'policy_version', p_id, jsonb_build_object('policy_key', v_row.policy_key, 'revision', v_row.revision));
end
$$;

-- 승인: owner 전용. 확인 항목 5개 전부 true, 인용 가능한 출처, 확인·유효 시각 검사. 같은 키의 기존 승인본은 교체된다.
create or replace function api.policy_approve(p_actor uuid, p_session uuid, p_token text, p_id uuid, p_reason text, p_checks jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row   core.policy_versions;
  v_k     text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if jsonb_typeof(p_checks) is distinct from 'object' then
    raise exception 'CHECKS_REQUIRED' using errcode = '22023';
  end if;
  foreach v_k in array array['source_matched', 'validity', 'vat', 'benefit_terms', 'region_bundle'] loop
    if (p_checks -> v_k) is distinct from 'true'::jsonb then
      raise exception 'CHECKS_REQUIRED' using errcode = '22023';
    end if;
  end loop;
  select * into v_row from core.policy_versions v where v.id = p_id for update;
  if not found or v_row.state <> 'submitted' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_row.source_kind not in ('official_policy_sheet', 'distributor_notice') then
    raise exception 'SOURCE_NOT_QUOTABLE' using errcode = '22023';
  end if;
  if v_row.confirmed_at is null or v_row.confirmed_at > now() then
    raise exception 'CONFIRMED_AT_INVALID' using errcode = '22023';
  end if;
  if v_row.valid_until is null or v_row.valid_until <= now() then
    raise exception 'VALIDITY_INVALID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('policy:' || v_row.policy_key, 0));
  update core.policy_versions set state = 'superseded', superseded_at = now()
   where policy_key = v_row.policy_key and state = 'approved';
  update core.policy_versions
     set state = 'approved', decided_by = v_staff.user_id, decided_at = now(), decision_reason = btrim(p_reason),
         self_approval = (v_row.created_by = v_staff.user_id), checks = p_checks
   where id = p_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'policy.approve', 'policy_version', p_id, btrim(p_reason),
          jsonb_build_object('policy_key', v_row.policy_key, 'revision', v_row.revision, 'content_hash', v_row.content_hash,
                             'self_approval', v_row.created_by = v_staff.user_id));
end
$$;

create or replace function api.policy_reject(p_actor uuid, p_session uuid, p_token text, p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row   core.policy_versions;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select * into v_row from core.policy_versions v where v.id = p_id for update;
  if not found or v_row.state <> 'submitted' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update core.policy_versions set state = 'rejected', decided_by = v_staff.user_id, decided_at = now(), decision_reason = btrim(p_reason)
   where id = p_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'policy.reject', 'policy_version', p_id, btrim(p_reason),
          jsonb_build_object('policy_key', v_row.policy_key, 'revision', v_row.revision));
end
$$;

-- 게시: 승인됐고 지금 유효하며 스위치(policy_publish)가 켜진 정책만, 고객 견적에 쓰는 필드만 돌려준다.
-- 시각은 DB now()로 판단한다(호출자가 시각을 줄 수 없다). 상품이 비활성이면 돌려주지 않는다.
create or replace function api.policy_published()
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce((select f.enabled from core.feature_flags f where f.key = 'policy_publish'), false) then
    return;
  end if;
  return query
  select jsonb_build_object(
           'supplierId', v.supplier_id, 'segment', v.segment, 'carrier', v.carrier, 'productId', v.product_id,
           'productLabel', v.product_label, 'category', v.category, 'version', 'r' || v.revision::text,
           'sourceKind', v.source_kind,
           'confirmedAt', to_char(v.confirmed_at at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'),
           'validFrom', to_char(v.valid_from at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'),
           'validUntil', jsonb_build_object('known', true,
             'value', to_char(v.valid_until at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"')),
           'reviewStatus', 'approved'
         ) || v.terms
  from core.policy_versions v
  join core.product_catalog c on c.product_key = v.category and c.status = 'active'
  where v.state = 'approved' and v.confirmed_at <= now() and v.valid_from <= now() and v.valid_until > now();
end
$$;

commit;
