-- 0014: 정책 게시 ON/OFF(대표 전용)와 필수 고지 문구 입력·버전 관리 (PM 11/21). 접수 개방·외부 호출 없음.
--  - api.policy_publish_get: 게시 스위치(policy_publish) 상태 조회(대표·정책 담당·검토자).
--  - api.policy_publish_set: 대표만, 사유 필수, 변경 전후를 감사에 기록(policy.publish_on / policy.publish_off).
--  - api.notice_text_list / api.notice_text_add: 고지 문구는 (버전, 키)별 추가만 가능하고 수정·삭제는 기존 가드가 막는다.
--    문구를 DB에 넣어도 접수는 열리지 않는다: 접수는 코드 상수 REQUIRED_NOTICES.confirmed(대표·PM 확정)가 true가 될 때만 열린다.
begin;

create or replace function api.policy_publish_get(p_actor uuid, p_session uuid, p_token text)
returns table (enabled boolean, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'policy_editor', 'reviewer']);
  return query select f.enabled, f.updated_at from core.feature_flags f where f.key = 'policy_publish';
end
$$;

create or replace function api.policy_publish_set(p_actor uuid, p_session uuid, p_token text, p_enabled boolean, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   boolean;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_enabled is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select f.enabled into v_old from core.feature_flags f where f.key = 'policy_publish' for update;
  update core.feature_flags
     set enabled = p_enabled, disabled_reason = case when p_enabled then null else 'operator' end,
         updated_by = v_staff.user_id, updated_at = now()
   where key = 'policy_publish';
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, case when p_enabled then 'policy.publish_on' else 'policy.publish_off' end, 'feature_flag', null, btrim(p_reason),
          jsonb_build_object('old', v_old, 'new', p_enabled));
end
$$;

create or replace function api.notice_text_list(p_actor uuid, p_session uuid, p_token text)
returns table (version text, notice_key text, body text, body_sha256 text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  return query select n.version, n.notice_key, n.body, n.body_sha256, n.created_at from core.notice_texts n order by n.created_at desc, n.version, n.notice_key limit 200;
end
$$;

create or replace function api.notice_text_add(p_actor uuid, p_session uuid, p_token text, p_version text, p_key text, p_body text, p_reason text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_sha   text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_version is null or p_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     or p_key is null or p_key !~ '^[a-z][a-z0-9_]{0,39}$'
     or p_body is null or length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'INVALID_NOTICE' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if exists (select 1 from core.notice_texts n where n.version = p_version and n.notice_key = p_key) then
    raise exception 'NOTICE_EXISTS' using errcode = '22023';
  end if;
  insert into core.notice_texts (version, notice_key, body, body_sha256) values (p_version, p_key, btrim(p_body), repeat('0', 64));
  select n.body_sha256 into v_sha from core.notice_texts n where n.version = p_version and n.notice_key = p_key;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'notice.text_add', 'notice_text', null, btrim(p_reason), jsonb_build_object('version', p_version, 'key', p_key, 'sha256', v_sha));
  return v_sha;
end
$$;

commit;
