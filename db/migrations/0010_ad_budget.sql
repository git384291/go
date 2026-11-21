-- 0010: 광고 예산 통제. 승인 없이는 지출을 허용하지 않고, 한도·중복·만료를 DB가 판정한다(PM 11/21).
-- 실제 광고 집행·외부 호출은 없다. 이 함수들은 '지출해도 되는지'만 판정하고 기록한다(집행 주체는 아직 없음).
--  - 승인·철회: owner만. 지출 판정: owner만(집행 주체가 생기면 별도 역할을 따로 승인받는다).
--  - 기본은 차단: 활성 승인이 없으면 BLOCK(NO_APPROVAL). 입력 오류·권한 오류는 예외(호출측은 차단으로 취급).
--  - 한도 상한은 코드의 승인 상한(campaignDraft: 일 10,000원·첫 3일 30,000원)과 같다. 입력으로 올릴 수 없다.
--  - 차단·허용 모두 감사 기록(core.audit_logs)에 남는다. 지출 원장은 추가 전용(수정·삭제 불가).
begin;

create table core.ad_budget_approvals (
  id            uuid primary key default gen_random_uuid(),
  campaign_key  text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  daily_cap_krw int  not null check (daily_cap_krw between 1 and 10000),
  total_cap_krw int  not null check (total_cap_krw between 1 and 30000),
  valid_from    timestamptz not null default now(),
  valid_until   timestamptz not null,
  state         text not null default 'active' check (state in ('active', 'revoked')),
  approved_by   uuid not null,
  reason        text not null check (length(reason) between 2 and 500),
  created_at    timestamptz not null default now(),
  revoked_by    uuid,
  revoked_at    timestamptz,
  revoke_reason text check (revoke_reason is null or length(revoke_reason) between 2 and 500),
  check (total_cap_krw >= daily_cap_krw),
  check (valid_until > valid_from and valid_until <= valid_from + interval '3 days')
);
create unique index ad_budget_one_active on core.ad_budget_approvals (campaign_key) where state = 'active';

create table core.ad_spend_ledger (
  id           bigint generated always as identity primary key,
  campaign_key text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  approval_id  uuid not null references core.ad_budget_approvals (id),
  spend_date   date not null,
  amount_krw   int  not null check (amount_krw between 1 and 10000),
  request_key  text not null unique check (request_key ~ '^[A-Za-z0-9-]{16,64}$'),
  recorded_by  uuid not null,
  created_at   timestamptz not null default now()
);
create index ad_spend_ledger_campaign_date on core.ad_spend_ledger (campaign_key, spend_date);

create or replace function core.ad_budget_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'ad_spend_ledger' then
    raise exception 'AD_LEDGER_IMMUTABLE' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'AD_APPROVAL_IMMUTABLE' using errcode = '42501';
  end if;
  -- 승인 행은 active → revoked 한 방향만 바뀌고, 내용 열은 바뀌지 않는다
  if old.state <> 'active' or new.state <> 'revoked'
     or (new.campaign_key, new.daily_cap_krw, new.total_cap_krw, new.valid_from, new.valid_until, new.approved_by, new.reason, new.created_at)
        is distinct from
        (old.campaign_key, old.daily_cap_krw, old.total_cap_krw, old.valid_from, old.valid_until, old.approved_by, old.reason, old.created_at) then
    raise exception 'AD_APPROVAL_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger ad_budget_approvals_guard before update or delete on core.ad_budget_approvals
  for each row execute function core.ad_budget_guard();
create trigger ad_spend_ledger_guard before update or delete on core.ad_spend_ledger
  for each row execute function core.ad_budget_guard();

-- 승인: 같은 캠페인의 기존 활성 승인은 철회하고 새로 만든다. owner만.
create or replace function api.ad_budget_approve(p_actor uuid, p_session uuid, p_token text, p_campaign text,
    p_daily int, p_total int, p_valid_until timestamptz, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_id    uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_daily is null or p_daily not between 1 and 10000
     or p_total is null or p_total not between 1 and 30000 or p_total < p_daily
     or p_valid_until is null or p_valid_until <= now() or p_valid_until > now() + interval '3 days' then
    raise exception 'INVALID_BUDGET' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:' || p_campaign, 0));
  update core.ad_budget_approvals
     set state = 'revoked', revoked_by = v_staff.user_id, revoked_at = now(), revoke_reason = '새 승인으로 교체'
   where campaign_key = p_campaign and state = 'active';
  insert into core.ad_budget_approvals (campaign_key, daily_cap_krw, total_cap_krw, valid_until, approved_by, reason)
  values (p_campaign, p_daily, p_total, p_valid_until, v_staff.user_id, btrim(p_reason))
  returning id into v_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.budget_approve', 'ad_budget_approval', v_id, btrim(p_reason),
          jsonb_build_object('campaign', p_campaign, 'daily_cap_krw', p_daily, 'total_cap_krw', p_total, 'valid_until', p_valid_until));
  return v_id;
end
$$;

create or replace function api.ad_budget_revoke(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_id    uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'INVALID_BUDGET' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:' || p_campaign, 0));
  update core.ad_budget_approvals
     set state = 'revoked', revoked_by = v_staff.user_id, revoked_at = now(), revoke_reason = btrim(p_reason)
   where campaign_key = p_campaign and state = 'active'
  returning id into v_id;
  if v_id is null then
    raise exception 'NO_ACTIVE_APPROVAL' using errcode = '22023';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.budget_revoke', 'ad_budget_approval', v_id, btrim(p_reason), jsonb_build_object('campaign', p_campaign));
end
$$;

-- 지출 판정: 허용이면 원장에 기록하고, 차단이면 이유와 함께 감사 기록만 남긴다. 같은 요청 키는 두 번 세지 않는다.
create or replace function api.ad_spend_request(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_amount int, p_request_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff  core.staff;
  v_app    core.ad_budget_approvals;
  v_today  date := (now() at time zone 'Asia/Seoul')::date;
  v_day    int;
  v_total  int;
  v_reason text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_amount is null or p_amount not between 1 and 10000
     or p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'INVALID_SPEND' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:' || p_campaign, 0));

  if exists (select 1 from core.ad_spend_ledger l where l.request_key = p_request_key) then
    v_reason := 'DUPLICATE_REQUEST';
  else
    select * into v_app from core.ad_budget_approvals a where a.campaign_key = p_campaign and a.state = 'active';
    if not found then
      v_reason := 'NO_APPROVAL';
    elsif v_app.valid_from > now() or v_app.valid_until <= now() then
      v_reason := 'APPROVAL_EXPIRED';
    else
      select coalesce(sum(l.amount_krw), 0) into v_day from core.ad_spend_ledger l where l.campaign_key = p_campaign and l.spend_date = v_today;
      select coalesce(sum(l.amount_krw), 0) into v_total from core.ad_spend_ledger l where l.approval_id = v_app.id;
      if v_day + p_amount > v_app.daily_cap_krw then
        v_reason := 'DAILY_CAP_EXCEEDED';
      elsif v_total + p_amount > v_app.total_cap_krw then
        v_reason := 'TOTAL_CAP_EXCEEDED';
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (v_staff.user_id, 'ad.spend_blocked', 'ad_budget_approval', v_app.id, v_reason,
            jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount));
    return jsonb_build_object('decision', 'BLOCK', 'reason', v_reason);
  end if;

  insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
  values (p_campaign, v_app.id, v_today, p_amount, p_request_key, v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.spend_allow', 'ad_budget_approval', v_app.id, null,
          jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount, 'spent_today', v_day + p_amount, 'spent_total', v_total + p_amount));
  return jsonb_build_object('decision', 'ALLOW', 'reason', null,
    'spent_today', v_day + p_amount, 'daily_cap_krw', v_app.daily_cap_krw,
    'spent_total', v_total + p_amount, 'total_cap_krw', v_app.total_cap_krw,
    'warn', (v_day + p_amount) >= v_app.daily_cap_krw * 0.8 or (v_total + p_amount) >= v_app.total_cap_krw * 0.8);
end
$$;

-- 화면용 조회: 승인 내역과 지금까지의 지출 합계. owner·reviewer.
create or replace function api.ad_budget_overview(p_actor uuid, p_session uuid, p_token text, p_limit int)
returns table (id uuid, campaign_key text, state text, daily_cap_krw int, total_cap_krw int, valid_until timestamptz,
               reason text, created_at timestamptz, revoke_reason text, spent_today int, spent_total int)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  return query
    select a.id, a.campaign_key, a.state, a.daily_cap_krw, a.total_cap_krw, a.valid_until, a.reason, a.created_at, a.revoke_reason,
           coalesce((select sum(l.amount_krw) from core.ad_spend_ledger l
                      where l.campaign_key = a.campaign_key and l.spend_date = (now() at time zone 'Asia/Seoul')::date), 0)::int,
           coalesce((select sum(l.amount_krw) from core.ad_spend_ledger l where l.approval_id = a.id), 0)::int
      from core.ad_budget_approvals a
     order by a.created_at desc
     limit p_limit;
end
$$;

commit;
