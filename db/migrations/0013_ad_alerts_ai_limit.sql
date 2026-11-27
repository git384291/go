-- 0013: 광고 중지 실패 경고 + 관리자 AI 월 한도 설정 (PM 11/21). 실제 광고 집행·외부 AI 호출 없음.
--  - core.ad_alerts: 자동 중지가 끝까지 되지 않았을 때(승인 철회 실패 또는 플랫폼 중지 실패) 서버가 경고를 연다(캠페인당 열린 경고 1건).
--    경고가 열려 있으면 해당 캠페인의 지출 판정은 STOP_PENDING으로 차단되고 새 승인도 만들 수 없다. 대표가 확인·해결해야 풀린다.
--  - api.ai_budget_limit_get/set: AI 월 한도 조회(대표·검토자)·설정(대표, 사유 필수, 감사 기록, 상한 100,000원).
begin;

create table core.ad_alerts (
  id            uuid primary key default gen_random_uuid(),
  campaign_key  text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  kind          text not null check (kind in ('stop_failed')),
  detail        jsonb not null,
  state         text not null default 'open' check (state in ('open', 'resolved')),
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  resolved_by   uuid,
  resolved_at   timestamptz,
  resolve_note  text check (resolve_note is null or length(resolve_note) between 2 and 500)
);
create unique index ad_alerts_one_open on core.ad_alerts (campaign_key) where state = 'open';

create or replace function core.ad_alert_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.state <> 'open' or new.state <> 'resolved'
     or (new.campaign_key, new.kind, new.detail, new.created_by, new.created_at) is distinct from (old.campaign_key, old.kind, old.detail, old.created_by, old.created_at) then
    raise exception 'AD_ALERT_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger ad_alerts_guard before update or delete on core.ad_alerts for each row execute function core.ad_alert_guard();

-- 경고 열기: 같은 캠페인에 열린 경고가 있으면 그 번호를 돌려준다(멱등). 대표만.
create or replace function api.ad_alert_open(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_detail jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_id    uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or p_detail is null or jsonb_typeof(p_detail) <> 'object' or length(p_detail::text) > 2000 then
    raise exception 'INVALID_ALERT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:' || p_campaign, 0));
  select a.id into v_id from core.ad_alerts a where a.campaign_key = p_campaign and a.state = 'open';
  if v_id is not null then
    return v_id;
  end if;
  insert into core.ad_alerts (campaign_key, kind, detail, created_by) values (p_campaign, 'stop_failed', p_detail, v_staff.user_id) returning id into v_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.stop_failed', 'ad_alert', v_id, null, jsonb_build_object('campaign', p_campaign) || p_detail);
  return v_id;
end
$$;

create or replace function api.ad_alert_resolve(p_actor uuid, p_session uuid, p_token text, p_id uuid, p_note text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_camp  text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_id is null or p_note is null or length(btrim(p_note)) not between 2 and 500 then
    raise exception 'INVALID_ALERT' using errcode = '22023';
  end if;
  update core.ad_alerts set state = 'resolved', resolved_by = v_staff.user_id, resolved_at = now(), resolve_note = btrim(p_note)
   where id = p_id and state = 'open' returning campaign_key into v_camp;
  if v_camp is null then
    raise exception 'NO_OPEN_ALERT' using errcode = '22023';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.alert_resolve', 'ad_alert', p_id, btrim(p_note), jsonb_build_object('campaign', v_camp));
end
$$;

create or replace function api.ad_alert_list(p_actor uuid, p_session uuid, p_token text, p_limit int)
returns table (id uuid, campaign_key text, state text, detail jsonb, created_at timestamptz, resolved_at timestamptz, resolve_note text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  return query select a.id, a.campaign_key, a.state, a.detail, a.created_at, a.resolved_at, a.resolve_note
    from core.ad_alerts a order by (a.state = 'open') desc, a.created_at desc limit p_limit;
end
$$;

-- 0013: 열린 경고가 있으면 승인(새 승인)·지출 판정이 막힌다(0010 함수에 한 단계씩 추가)
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
  -- 0013: 중지 실패 경고가 해결되기 전에는 새 승인을 만들 수 없다
  if exists (select 1 from core.ad_alerts al where al.campaign_key = p_campaign and al.state = 'open') then
    raise exception 'ALERT_OPEN' using errcode = '22023';
  end if;
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
  elsif exists (select 1 from core.ad_alerts al where al.campaign_key = p_campaign and al.state = 'open') then
    v_reason := 'STOP_PENDING';  -- 0013: 중지 실패 경고가 열려 있는 동안 모든 지출 차단
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

-- AI 월 한도: 조회는 이번 달 사용액(정산 반영)과 미정산 예약 건수까지 보여 준다. 설정은 대표만, 사유 필수, 감사 기록.
create or replace function api.ai_budget_limit_get(p_actor uuid, p_session uuid, p_token text)
returns table (month text, monthly_limit_krw int, used_krw int, unconfirmed_count int)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_month text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM');
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  return query
    select v_month,
           (select c.monthly_limit_krw from core.ai_budget_config c where c.singleton),
           coalesce((select sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end)
                       from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id where u.month = v_month), 0)::int,
           (select count(*) from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id where u.month = v_month and s.reservation_id is null)::int;
end
$$;

create or replace function api.ai_budget_limit_set(p_actor uuid, p_session uuid, p_token text, p_limit int, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_limit is null or p_limit not between 0 and 100000 then
    raise exception 'INVALID_LIMIT' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select c.monthly_limit_krw into v_old from core.ai_budget_config c where c.singleton for update;
  update core.ai_budget_config set monthly_limit_krw = p_limit, updated_at = now() where singleton;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ai.budget_limit_set', 'ai_budget_config', null, btrim(p_reason), jsonb_build_object('old_limit_krw', v_old, 'new_limit_krw', p_limit));
end
$$;

commit;
