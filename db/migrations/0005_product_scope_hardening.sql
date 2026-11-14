-- 0005_product_scope_hardening.sql
-- FIDEON PM PHASE 1 보완(검수 지적 1·2항): 승인 서명 재사용 방지, 승인·활성화 동시성 보강
--
-- 재현된 문제(0004): 같은 승인 서명을 유효 시간(최대 5분) 안에 다시 넣으면 승인 행이 반복 저장되고,
--                    예약으로 되돌린 상품을 같은 서명으로 다시 활성화할 수 있었다.
-- 보완:
--   1) 서명 지문(SHA-256)을 승인 행에 남기고 고유 인덱스로 영구 1회용 처리(승인 행은 삭제·수정 불가이므로 지문도 영구 보존)
--   2) 같은 상품·같은 승인 종류의 미소진 승인은 1건만(부분 고유 인덱스)
--   3) 동시 요청은 잠금으로 줄을 세운 뒤 다시 확인 → 명확한 오류. 인덱스는 최후 방어선
--   4) 활성화 시 승인 행을 FOR UPDATE로 잠가 동시 활성화에서 같은 승인을 두 번 쓰지 못하게 함
-- 0004의 두 보호 함수는 위 변경만 더해 교체한다(그 밖의 본문 동일). 0001~0004는 수정하지 않는다.
begin;

alter table core.product_activation_approvals add column proof_sha256 text
  check (proof_sha256 is null or proof_sha256 ~ '^[0-9a-f]{64}$');
create unique index product_approvals_proof_once on core.product_activation_approvals (proof_sha256);
create unique index product_approvals_one_open on core.product_activation_approvals (product_key, approval_kind)
  where consumed_at is null;

create or replace function core.product_approval_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_need text;
  v_hash text;
begin
  if tg_op = 'DELETE' then
    raise exception 'APPROVAL_IMMUTABLE' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    -- 허용되는 변경은 '소진 표시' 하나뿐(되돌리기·내용 변경 불가)
    if old.consumed_at is null and new.consumed_at is not null
       and (new.id, new.product_key, new.approval_kind, new.staff_id, new.session_id, new.reason, new.created_at, new.proof_sha256)
           is not distinct from
           (old.id, old.product_key, old.approval_kind, old.staff_id, old.session_id, old.reason, old.created_at, old.proof_sha256)
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

  -- 0005: 서명 1회용. 같은 서명은 유효 시간(최대 5분) 안이라도, 승인이 소진·무효화된 뒤라도 다시 쓸 수 없다.
  --       동시에 같은 서명이 들어오면 잠금으로 줄을 세운 뒤 다시 확인한다(고유 인덱스는 최후 방어선).
  v_hash := encode(extensions.digest(convert_to(new.proof, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('approval-proof:' || v_hash, 0));
  if exists (select 1 from core.product_activation_approvals a where a.proof_sha256 = v_hash) then
    raise exception 'APPROVAL_PROOF_REUSED' using errcode = '42501';
  end if;

  -- 0005: 같은 상품·같은 승인 종류의 미소진 승인은 1건만. 동시 기록도 잠금으로 줄을 세운다.
  perform pg_advisory_xact_lock(hashtextextended('approval-slot:' || new.product_key || ':' || new.approval_kind, 0));
  -- 7일이 지나 활성화에 쓸 수 없게 된 승인은 이 시점에 소진 처리해 새 승인을 막지 않게 한다
  update core.product_activation_approvals a
     set consumed_at = now()
   where a.product_key = new.product_key and a.approval_kind = new.approval_kind
     and a.consumed_at is null and a.created_at <= now() - interval '7 days';
  if exists (select 1 from core.product_activation_approvals a
             where a.product_key = new.product_key and a.approval_kind = new.approval_kind and a.consumed_at is null) then
    raise exception 'APPROVAL_ALREADY_PENDING' using errcode = '42501';
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

  new.proof_sha256 := v_hash;  -- 서명 원문 대신 지문만 남긴다(재사용 확인용)
  new.proof       := null;     -- 서명은 저장하지 않는다
  new.created_at  := now();    -- 승인 시각은 DB가 정한다(과거·미래 날짜 입력 불가)
  new.consumed_at := null;
  insert into core.audit_logs (actor_id, action, target_type, reason, detail)
  values (new.staff_id, 'product.approve', 'product', new.reason,
          jsonb_build_object('product', new.product_key, 'kind', new.approval_kind, 'approval_id', new.id));
  return new;
end
$$;

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
    order by a.created_at desc limit 1
    for update of a;   -- 0005: 동시 활성화 시 같은 승인을 두 번 쓰지 못하게 잠근다
    select a.staff_id into v_pm
    from core.product_activation_approvals a join core.staff st on st.user_id = a.staff_id
    where a.product_key = new.product_key and a.approval_kind = 'pm' and a.consumed_at is null
      and a.created_at > now() - interval '7 days' and st.active and st.role = 'reviewer'
    order by a.created_at desc limit 1
    for update of a;   -- 0005: 동시 활성화 시 같은 승인을 두 번 쓰지 못하게 잠근다
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

revoke all on function core.product_approval_guard(), core.product_catalog_guard() from public;

commit;
