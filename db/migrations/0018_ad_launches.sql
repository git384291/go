-- 0018: 광고 launch 상태 저장 (PM 11/22 P1). 실제 광고 API 연결 전 안전장치. 실제 집행·외부 호출 없음.
--  - core.ad_launches: 캠페인별 launch 시도(요청 키·플랫폼 externalId·상태). 열린 launch(requested/active/unknown)는 캠페인당 1건만 허용한다.
--    상태: requested(호출 직전) → active(플랫폼 확인) | failed(집행 안 됨이 확실) | unknown(집행 여부 불명: 사람이 확인하기 전 재launch 금지) → (resolve) active|failed, active → paused.
--  - 행은 삭제 불가, 상태 전이만 허용(가드 트리거). 쓰기는 owner 전용 api 함수로만 한다. 키·토큰은 저장하지 않는다(externalId·고정 코드만).
begin;

create table core.ad_launches (
  id           uuid primary key default gen_random_uuid(),
  campaign_key text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  request_key  text not null unique check (request_key ~ '^[A-Za-z0-9-]{16,64}$'),
  amount_krw   int  not null check (amount_krw between 1 and 10000),
  state        text not null default 'requested' check (state in ('requested', 'active', 'paused', 'failed', 'unknown')),
  external_id  text check (external_id is null or length(external_id) between 1 and 100),
  note         text check (note is null or note ~ '^[A-Z_]{2,40}$'),
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (state not in ('active', 'paused') or external_id is not null)
);
create unique index ad_launches_one_open on core.ad_launches (campaign_key) where state in ('requested', 'active', 'unknown');

create or replace function core.ad_launch_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     or (new.id, new.campaign_key, new.request_key, new.amount_krw, new.created_by, new.created_at)
        is distinct from (old.id, old.campaign_key, old.request_key, old.amount_krw, old.created_by, old.created_at)
     or (old.external_id is not null and new.external_id is distinct from old.external_id)
     or not ((old.state = 'requested' and new.state in ('active', 'failed', 'unknown'))
          or (old.state = 'unknown' and new.state in ('active', 'failed'))
          or (old.state = 'active' and new.state = 'paused')) then
    raise exception 'AD_LAUNCH_IMMUTABLE' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger ad_launches_guard before update or delete on core.ad_launches for each row execute function core.ad_launch_guard();

-- launch 시작: 같은 요청 키·열린 launch가 있으면 거부(지출 판정보다 먼저 부른다). 불명(unknown)이 열려 있으면 LAUNCH_UNKNOWN.
create or replace function api.ad_launch_begin(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_request_key text, p_amount int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_open  core.ad_launches;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$'
     or p_amount is null or p_amount not between 1 and 10000 then
    raise exception 'INVALID_LAUNCH' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adlaunch:' || p_campaign, 0));
  if exists (select 1 from core.ad_launches l where l.request_key = p_request_key) then
    return jsonb_build_object('ok', false, 'reason', 'DUPLICATE_REQUEST');
  end if;
  select * into v_open from core.ad_launches l where l.campaign_key = p_campaign and l.state in ('requested', 'active', 'unknown');
  if found then
    return jsonb_build_object('ok', false, 'reason', case v_open.state when 'unknown' then 'LAUNCH_UNKNOWN' else 'LAUNCH_ACTIVE' end);
  end if;
  insert into core.ad_launches (campaign_key, request_key, amount_krw, created_by) values (p_campaign, p_request_key, p_amount, v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.launch_begin', 'ad_launch', null, null, jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount));
  return jsonb_build_object('ok', true);
end
$$;

-- launch 결과 기록: requested → active(externalId 필수) | failed | unknown. note는 고정 코드(대문자·_)만.
create or replace function api.ad_launch_finish(p_actor uuid, p_session uuid, p_token text, p_request_key text, p_state text, p_external_id text, p_note text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row   core.ad_launches;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$' or p_state not in ('active', 'failed', 'unknown')
     or (p_state = 'active' and (p_external_id is null or length(p_external_id) not between 1 and 100))
     or (p_note is not null and p_note !~ '^[A-Z_]{2,40}$') then
    raise exception 'INVALID_LAUNCH' using errcode = '22023';
  end if;
  update core.ad_launches set state = p_state, external_id = case when p_state = 'active' then p_external_id else external_id end, note = p_note
   where request_key = p_request_key and state = 'requested' returning * into v_row;
  if not found then raise exception 'NO_LAUNCH' using errcode = '22023'; end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.launch_' || p_state, 'ad_launch', v_row.id, null, jsonb_build_object('campaign', v_row.campaign_key, 'note', p_note));
  return jsonb_build_object('ok', true);
end
$$;

-- 캠페인의 현재 launch 조회(pause·성과조회가 externalId로 처리하도록): 열린 것(requested/active/unknown) 우선, 없으면 가장 최근 paused(마지막 날 성과 수집용). failed는 제외. owner·reviewer. 없으면 null.
create or replace function api.ad_launch_active(p_actor uuid, p_session uuid, p_token text, p_campaign text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row   core.ad_launches;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then raise exception 'INVALID_LAUNCH' using errcode = '22023'; end if;
  select * into v_row from core.ad_launches l where l.campaign_key = p_campaign and l.state in ('requested', 'active', 'unknown', 'paused')
   order by (l.state <> 'paused') desc, l.created_at desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('state', v_row.state, 'external_id', v_row.external_id, 'request_key', v_row.request_key, 'amount_krw', v_row.amount_krw);
end
$$;

-- 플랫폼 중지가 확인된 뒤 active → paused. 이미 paused거나 없으면 paused=false.
create or replace function api.ad_launch_paused(p_actor uuid, p_session uuid, p_token text, p_campaign text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row   core.ad_launches;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then raise exception 'INVALID_LAUNCH' using errcode = '22023'; end if;
  update core.ad_launches set state = 'paused' where campaign_key = p_campaign and state = 'active' returning * into v_row;
  if not found then return jsonb_build_object('ok', true, 'paused', false); end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.launch_paused', 'ad_launch', v_row.id, null, jsonb_build_object('campaign', p_campaign));
  return jsonb_build_object('ok', true, 'paused', true);
end
$$;

-- 불명(unknown)·미완료(requested) launch를 사람이 확인한 뒤 정리: not_executed → failed(재launch 가능), executed → active(externalId 필수). 사유 필수·감사 기록.
create or replace function api.ad_launch_resolve(p_actor uuid, p_session uuid, p_token text, p_request_key text, p_outcome text, p_external_id text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row   core.ad_launches;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$' or p_outcome not in ('not_executed', 'executed')
     or (p_outcome = 'executed' and (p_external_id is null or length(p_external_id) not between 1 and 100)) then
    raise exception 'INVALID_LAUNCH' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then raise exception 'REASON_REQUIRED' using errcode = '22023'; end if;
  update core.ad_launches
     set state = case p_outcome when 'executed' then 'active' else 'failed' end,
         external_id = case when p_outcome = 'executed' then p_external_id else external_id end, note = 'MANUAL_RESOLVED'
   where request_key = p_request_key and state in ('unknown', 'requested') returning * into v_row;
  if not found then raise exception 'NO_LAUNCH' using errcode = '22023'; end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.launch_resolve', 'ad_launch', v_row.id, btrim(p_reason), jsonb_build_object('campaign', v_row.campaign_key, 'outcome', p_outcome));
  return jsonb_build_object('ok', true);
end
$$;

commit;
