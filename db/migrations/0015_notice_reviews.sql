-- 0015: 총판 고지 조건 관리자 검수 기록 (PM 11/21). 접수 개방·외부 호출 없음.
--  - core.notice_reviews: 버전별 검수 결과(승인/반려)와 확인 항목 5개를 추가 전용으로 남긴다(수정·삭제 불가).
--  - api.notice_review_add: 검토자·대표. 승인은 5개 확인 항목이 모두 true + DB에 그 버전 문구가 있어야 하며,
--    그 버전 문구를 직접 입력한 사람은 승인할 수 없다(자기 입력 승인 금지). 검수 시점의 문구 묶음 해시를 함께 저장한다.
--  - api.notice_review_list: 검수 이력과 "현재 문구 묶음과 같은지(stale 여부)". 문구가 더 추가되면 이전 승인은 최신이 아니다.
--  - 검수 승인은 접수를 열지 않는다. 접수는 코드 상수 REQUIRED_NOTICES.confirmed(대표·PM 확정, 별도 배포)로만 열린다.
begin;

create table if not exists core.notice_reviews (
  id          uuid primary key default gen_random_uuid(),
  version     text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  decision    text not null check (decision in ('approved', 'rejected')),
  checks      jsonb not null,
  texts_sha256 text not null check (texts_sha256 ~ '^[0-9a-f]{64}$'),
  reason      text not null check (length(reason) between 2 and 500),
  reviewer_id uuid not null,
  created_at  timestamptz not null default now()
);
create index if not exists notice_reviews_version on core.notice_reviews (version, created_at desc);

create or replace function core.notice_reviews_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'NOTICE_REVIEW_IMMUTABLE' using errcode = '42501';
end
$$;
drop trigger if exists notice_reviews_guard on core.notice_reviews;
create trigger notice_reviews_guard before update or delete on core.notice_reviews
  for each row execute function core.notice_reviews_guard();
drop trigger if exists notice_reviews_no_truncate on core.notice_reviews;
create trigger notice_reviews_no_truncate before truncate on core.notice_reviews
  for each statement execute function core.block_truncate();

create or replace function api.notice_review_add(p_actor uuid, p_session uuid, p_token text, p_version text, p_checks jsonb, p_decision text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_sha   text;
  v_k     text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  if p_version is null or p_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' or p_decision is null or p_decision not in ('approved', 'rejected')
     or p_checks is null or jsonb_typeof(p_checks) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_checks)) <> 5 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  foreach v_k in array array['source_matched', 'version_matched', 'keys_complete', 'conditions_checked', 'screen_checked'] loop
    if not (p_checks ? v_k) or jsonb_typeof(p_checks -> v_k) <> 'boolean' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  -- 문구 묶음 해시: 항목 키 순서로 "키:문구해시"를 이어 붙인 값의 sha256(문구가 없으면 null)
  select encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex') into v_sha from core.notice_texts n where n.version = p_version;
  if v_sha is null then
    raise exception 'NOTICE_NOT_FOUND' using errcode = '22023';
  end if;
  if p_decision = 'approved' then
    if exists (select 1 from jsonb_each(p_checks) e where e.value <> 'true'::jsonb) then
      raise exception 'CHECKS_INCOMPLETE' using errcode = '22023';
    end if;
    if exists (select 1 from core.audit_logs a where a.action = 'notice.text_add' and a.detail ->> 'version' = p_version and a.actor_id = v_staff.user_id) then
      raise exception 'SELF_APPROVAL' using errcode = '42501';
    end if;
  end if;
  insert into core.notice_reviews (version, decision, checks, texts_sha256, reason, reviewer_id)
  values (p_version, p_decision, p_checks, v_sha, btrim(p_reason), v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'notice.review_' || p_decision, 'notice_version', null, btrim(p_reason),
          jsonb_build_object('version', p_version, 'texts_sha256', v_sha, 'checks', p_checks));
end
$$;

create or replace function api.notice_review_list(p_actor uuid, p_session uuid, p_token text)
returns table (version text, decision text, checks jsonb, reason text, created_at timestamptz, is_current boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  return query
    select r.version, r.decision, r.checks, r.reason, r.created_at, (r.texts_sha256 is not distinct from (select encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex') from core.notice_texts n where n.version = r.version))
      from core.notice_reviews r order by r.created_at desc, r.version limit 200;
end
$$;

commit;
