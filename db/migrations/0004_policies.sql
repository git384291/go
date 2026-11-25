-- 0004_policies.sql
-- 정책 문서(개인정보처리방침·이용약관) 작성 → 승인 → 게시, 버전 관리, 감사 기록
-- 규칙
--   1) 상태 흐름은 draft → approved → published → retired 한 방향만 허용(트리거로 강제)
--   2) 작성자 본인은 승인 불가(직무 분리), 게시는 owner만, 'policy_publish' 기능 스위치가 켜져 있어야 함
--   3) 종류(kind)별 게시 상태 문서는 항상 최대 1개(부분 유일 인덱스 + 종류별 잠금)
--   4) 게시는 한 트랜잭션: 이전 게시본 retired + 새 문서 published + 설정 버전 갱신 + 감사 기록. 하나라도 실패하면 전부 취소
--   5) 본문·버전은 작성 후 변경 불가(바꾸려면 새 버전 작성)
begin;

create table core.policy_documents (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('privacy', 'terms')),
  version      text not null check (version ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  body         text not null check (length(btrim(body)) between 1 and 200000),
  body_sha256  text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  status       text not null default 'draft' check (status in ('draft', 'approved', 'published', 'retired')),
  created_by   uuid not null references core.staff(user_id),
  created_at   timestamptz not null default now(),
  approved_by  uuid references core.staff(user_id),
  approved_at  timestamptz,
  published_by uuid references core.staff(user_id),
  published_at timestamptz,
  retired_at   timestamptz,
  unique (kind, version),
  check (approved_by is null or approved_by <> created_by),
  check ((status = 'draft') = (approved_by is null)),
  check ((status in ('published', 'retired')) = (published_at is not null)),
  check ((status = 'retired') = (retired_at is not null))
);
-- 종류별 게시 문서 최대 1개 (동시 게시 경쟁에서도 DB가 최종 보장)
create unique index policy_documents_one_published on core.policy_documents (kind) where status = 'published';
create index policy_documents_kind_status on core.policy_documents (kind, status);

-- 상태 전이·불변 필드 강제. 함수 버그나 직접 수정 시도가 있어도 DB가 막는다.
create or replace function core.policy_documents_guard()
returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'POLICY_DELETE_FORBIDDEN' using errcode = '42501';
  end if;
  if new.kind <> old.kind or new.version <> old.version or new.body <> old.body
     or new.body_sha256 <> old.body_sha256 or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'POLICY_IMMUTABLE' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and (old.status, new.status) not in (('draft', 'approved'), ('approved', 'published'), ('published', 'retired')) then
    raise exception 'INVALID_TRANSITION % -> %', old.status, new.status using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger policy_documents_guard before update or delete on core.policy_documents
  for each row execute function core.policy_documents_guard();

-- 작성: owner, policy_editor
create or replace function api.policy_create(p_actor uuid, p_session uuid, p_token text,
                                             p_kind text, p_version text, p_body text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_id    uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'policy_editor']);
  begin
    insert into core.policy_documents (kind, version, body, body_sha256, created_by)
    values (p_kind, p_version, p_body,
            encode(extensions.digest(convert_to(coalesce(p_body, ''), 'UTF8'), 'sha256'), 'hex'), v_staff.user_id)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_VERSION' using errcode = '23505';
  end;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'policy.create', 'policy_document', v_id,
          jsonb_build_object('kind', p_kind, 'version', p_version));
  return v_id;
end
$$;

-- 승인: owner, reviewer. 작성자 본인 승인 불가
create or replace function api.policy_approve(p_actor uuid, p_session uuid, p_token text, p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_doc   core.policy_documents;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  if length(btrim(coalesce(p_reason, ''))) < 2 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select d.* into v_doc from core.policy_documents d where d.id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if v_doc.created_by = v_staff.user_id then
    raise exception 'SELF_APPROVAL' using errcode = '42501';
  end if;
  if v_doc.status <> 'draft' then
    raise exception 'INVALID_STATE %', v_doc.status using errcode = '55000';
  end if;
  update core.policy_documents set status = 'approved', approved_by = v_staff.user_id, approved_at = now()
   where id = p_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'policy.approve', 'policy_document', p_id, p_reason,
          jsonb_build_object('kind', v_doc.kind, 'version', v_doc.version));
end
$$;

-- 게시: owner만, 기능 스위치 필요. 이전 게시본 retired → 새 문서 published → 설정 버전 갱신 → 감사
create or replace function api.policy_publish(p_actor uuid, p_session uuid, p_token text, p_id uuid, p_reason text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_kind  text;
  v_doc   core.policy_documents;
  v_prev  core.policy_documents;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if not coalesce((select f.enabled from core.feature_flags f where f.key = 'policy_publish'), false) then
    raise exception 'FEATURE_DISABLED' using errcode = '55000';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  select d.kind into v_kind from core.policy_documents d where d.id = p_id;
  if v_kind is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  -- 같은 종류의 게시는 한 번에 하나만 진행(서로 다른 버전 동시 게시 경쟁 차단)
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('fideon.policy_publish.' || v_kind));

  -- 잠금 획득 후 상태를 다시 읽는다(먼저 끝난 요청의 결과 반영)
  select d.* into v_doc from core.policy_documents d where d.id = p_id for update;
  if v_doc.status = 'draft' then
    raise exception 'NOT_APPROVED' using errcode = '55000';
  elsif v_doc.status <> 'approved' then
    raise exception 'INVALID_STATE %', v_doc.status using errcode = '55000';
  end if;

  select d.* into v_prev from core.policy_documents d
   where d.kind = v_kind and d.status = 'published' for update;
  if found then
    update core.policy_documents set status = 'retired', retired_at = now() where id = v_prev.id;
  end if;
  update core.policy_documents
     set status = 'published', published_by = v_staff.user_id, published_at = now()
   where id = p_id;

  if v_kind = 'privacy' then
    insert into core.settings (key, value, updated_by, updated_at)
    values ('privacy_policy_version', to_jsonb(v_doc.version), v_staff.user_id, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'policy.publish', 'policy_document', p_id, p_reason,
          jsonb_build_object('kind', v_kind, 'version', v_doc.version,
                             'previous_id', v_prev.id, 'previous_version', v_prev.version));
  return v_doc.version;
end
$$;

-- 공개 조회: 종류별 현재 게시본 1개
create or replace function api.policy_current(p_kind text)
returns table (kind text, version text, body text, body_sha256 text, published_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select d.kind, d.version, d.body, d.body_sha256, d.published_at
  from core.policy_documents d
  where d.kind = p_kind and d.status = 'published'
$$;

-- 관리자 목록(본문 제외)
create or replace function api.policy_list(p_actor uuid, p_session uuid, p_token text, p_kind text)
returns table (id uuid, kind text, version text, status text, body_sha256 text,
               created_by uuid, created_at timestamptz, approved_by uuid, approved_at timestamptz,
               published_by uuid, published_at timestamptz, retired_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'policy_editor', 'reviewer']);
  return query
    select d.id, d.kind, d.version, d.status, d.body_sha256, d.created_by, d.created_at,
           d.approved_by, d.approved_at, d.published_by, d.published_at, d.retired_at
    from core.policy_documents d
    where p_kind is null or d.kind = p_kind
    order by d.created_at desc
    limit 200;
end
$$;

commit;
