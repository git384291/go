-- 0025: AI 사용료 하드 한도 보강 (P0 AI 비용 하드 한도 검증 GAP 해소). 실제 외부 AI 호출 없음. **운영 적용은 PM 승인 전 금지.**
--  - 한도 4종을 한 잠금 안에서 함께 판정: 서비스 월(기존)·서비스 일·사용자(scope)별 일·사용자별 월. 새 한도의 기본값은 0원 = 호출 금지(미설정 = 차단).
--    운영 값은 승인되지 않았다. 대표가 api.ai_budget_limits_set으로 정한다(사유 필수·감사 기록).
--  - 동시 요청 한도: 최근 2분 안에 만들어진 미정산 예약 수가 max_inflight 이상이면 거부(서버 인스턴스가 여럿이어도 DB 한 곳에서 센다).
--    2분보다 오래된 미정산 예약은 동시 수에서 빼되 사용액에는 계속 전액으로 센다(장애로 정산이 안 와도 영구 차단되지 않게).
--  - 긴급 차단: core.ai_budget_config.paused. 켜지면 새 예약 0건(진행 중 예약 수를 감사 기록에 남긴다). 대표만.
--  - 멱등: 예약마다 요청 ID(request_id) 필수·유일. 같은 ID는 다시 예약하지 않는다(null = 호출 금지, 재실행 없음).
--  - 사용자 구분 scope_key: 서버 HMAC(IP 해시 64자리)만. 원문 IP·개인정보 없음.
--  - 일 단위는 created_at의 한국 날짜(생성 열, 계산식 고정)로 센다. 월 키는 기존대로 한국 시간 YYYY-MM.
--  - 정산 보강: 확정은 1원 이상(호출이 나간 뒤 0원 정산으로 사용액을 지우지 못한다; 0원은 '호출 안 함' 취소만).
--    과금 여부 불확실(시간 초과 등)은 'uncertain'으로 닫고 예약 전액으로 센다 → 대표가 사용량 확인 후 조정(ai_budget_adjust, 1회, 감사 기록).
--  - 예전 서명 api.ai_budget_hold(int)·api.ai_budget_reserve(int)는 제거한다(새 한도·멱등을 우회하는 경로를 남기지 않는다).
begin;

alter table core.ai_budget_config
  add column paused                  boolean not null default false,
  add column daily_limit_krw         int not null default 0 check (daily_limit_krw between 0 and 1000000),
  add column scope_daily_limit_krw   int not null default 0 check (scope_daily_limit_krw between 0 and 1000000),
  add column scope_monthly_limit_krw int not null default 0 check (scope_monthly_limit_krw between 0 and 1000000),
  add column max_inflight            int not null default 0 check (max_inflight between 0 and 1000);  -- 동시 진행(미정산) 호출 상한, 0 = 호출 금지

alter table core.ai_usage_ledger
  add column day        date generated always as ((created_at at time zone 'Asia/Seoul')::date) stored,
  add column scope_key  text check (scope_key is null or scope_key ~ '^[0-9a-f]{64}$'),
  add column request_id text check (request_id is null or request_id ~ '^[A-Za-z0-9-]{16,64}$');
create unique index ai_usage_ledger_request on core.ai_usage_ledger (request_id) where request_id is not null;
create index ai_usage_ledger_day on core.ai_usage_ledger (day);
create index ai_usage_ledger_scope on core.ai_usage_ledger (scope_key, month);

alter table core.ai_usage_closures drop constraint ai_usage_closures_kind_check;
alter table core.ai_usage_closures drop constraint ai_usage_closures_check;
alter table core.ai_usage_closures
  add constraint ai_usage_closures_kind_check check (kind in ('confirm', 'cancel', 'uncertain')),
  add constraint ai_usage_closures_amount_check check ((kind = 'cancel' and actual_cost_krw = 0) or (kind in ('confirm', 'uncertain') and actual_cost_krw >= 1));

-- 불확실 정산의 사후 조정(예약당 1번, 추가 전용)
create table core.ai_usage_adjustments (
  reservation_id  bigint primary key references core.ai_usage_closures (reservation_id),
  actual_cost_krw int  not null check (actual_cost_krw between 0 and 1000),
  adjusted_by     uuid not null,
  reason          text not null check (length(reason) between 2 and 500),
  created_at      timestamptz not null default now()
);
create trigger ai_usage_adjustments_guard before update or delete on core.ai_usage_adjustments for each row execute function core.ad_ai_guard();

-- 예약 1건이 사용액에 들어가는 금액: 취소 0, 확정 실제, 불확실 = 조정값 또는 예약 전액, 미정산 = 예약 전액(보수적)
create or replace function core.ai_spent(p_month text, p_day date, p_scope text)
returns table (month_all bigint, day_all bigint, month_scope bigint, day_scope bigint)
language sql stable set search_path = '' as $$
  with x as (
    select u.month, u.day, u.scope_key,
           case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw
                       when 'uncertain' then coalesce(a.actual_cost_krw, s.actual_cost_krw) else u.cost_krw end as amt
      from core.ai_usage_ledger u
      left join core.ai_usage_closures s on s.reservation_id = u.id
      left join core.ai_usage_adjustments a on a.reservation_id = u.id
     where u.month = p_month or u.day = p_day
  )
  select coalesce(sum(amt) filter (where month = p_month), 0)::bigint,
         coalesce(sum(amt) filter (where day = p_day), 0)::bigint,
         coalesce(sum(amt) filter (where month = p_month and scope_key = p_scope), 0)::bigint,
         coalesce(sum(amt) filter (where day = p_day and scope_key = p_scope), 0)::bigint
    from x
$$;

drop function if exists api.ai_budget_reserve(int);
drop function if exists api.ai_budget_hold(int);

-- 예약: 입력 오류·긴급 차단·요청 ID 중복·한도 4종 중 하나라도 초과 → null(= 호출 금지). 한 전역 잠금 안에서 판정(동시 요청 직렬화)
create or replace function api.ai_budget_hold(p_cost int, p_request_id text, p_scope text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_now   timestamptz := now();
  v_month text := to_char(v_now at time zone 'Asia/Seoul', 'YYYY-MM');
  v_day   date := (v_now at time zone 'Asia/Seoul')::date;
  c       core.ai_budget_config;
  s       record;
  v_id    bigint;
begin
  if p_cost is null or p_cost not between 1 and 1000
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9-]{16,64}$'
     or p_scope is null or p_scope !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select * into c from core.ai_budget_config where singleton;
  if c is null or c.paused then
    return null;
  end if;
  if exists (select 1 from core.ai_usage_ledger u where u.request_id = p_request_id) then
    return null;  -- 같은 요청은 다시 예약·호출하지 않는다
  end if;
  if (select count(*) from core.ai_usage_ledger u left join core.ai_usage_closures x on x.reservation_id = u.id
       where x.reservation_id is null and u.created_at > v_now - interval '2 minutes') >= c.max_inflight then
    return null;  -- 동시 진행 호출 상한
  end if;
  select * into s from core.ai_spent(v_month, v_day, p_scope);
  if s.month_all + p_cost > c.monthly_limit_krw or s.day_all + p_cost > c.daily_limit_krw
     or s.month_scope + p_cost > c.scope_monthly_limit_krw or s.day_scope + p_cost > c.scope_daily_limit_krw then
    return null;
  end if;
  insert into core.ai_usage_ledger (month, cost_krw, scope_key, request_id, created_at)
  values (v_month, p_cost, p_scope, p_request_id, v_now) returning id into v_id;
  return v_id;
end
$$;

-- 확정: 호출이 나간 예약만, 1원 이상(예약당 1번)
create or replace function api.ai_budget_confirm(p_id bigint, p_actual int)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_id is null or p_actual is null or p_actual not between 1 and 1000 then
    return false;
  end if;
  if not exists (select 1 from core.ai_usage_ledger u where u.id = p_id) then
    return false;
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'confirm', p_actual)
  on conflict (reservation_id) do nothing;
  return found;
end
$$;

-- 과금 불확실: 예약 전액으로 닫고 조정 대기(예약당 1번)
create or replace function api.ai_budget_uncertain(p_id bigint)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_cost int;
begin
  select u.cost_krw into v_cost from core.ai_usage_ledger u where u.id = p_id;
  if v_cost is null then
    return false;
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'uncertain', v_cost)
  on conflict (reservation_id) do nothing;
  return found;
end
$$;

-- 조정: 대표만, 불확실 정산 건에 1번, 사유 필수, 감사 기록
create or replace function api.ai_budget_adjust(p_actor uuid, p_session uuid, p_token text, p_id bigint, p_actual int, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_id is null or p_actual is null or p_actual not between 0 and 1000 then
    raise exception 'INVALID_ADJUST' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select s.actual_cost_krw into v_old from core.ai_usage_closures s where s.reservation_id = p_id and s.kind = 'uncertain';
  if v_old is null then
    raise exception 'NOT_UNCERTAIN' using errcode = '22023';
  end if;
  insert into core.ai_usage_adjustments (reservation_id, actual_cost_krw, adjusted_by, reason)
  values (p_id, p_actual, v_staff.user_id, btrim(p_reason))
  on conflict (reservation_id) do nothing;
  if not found then
    raise exception 'ALREADY_ADJUSTED' using errcode = '22023';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ai.usage_adjust', 'ai_usage_ledger', null, btrim(p_reason),
          jsonb_build_object('reservation_id', p_id, 'reserved_krw', v_old, 'actual_krw', p_actual));
end
$$;

-- 긴급 차단 켜기·끄기: 대표만, 사유 필수, 감사 기록(그 순간 미정산 예약 수 포함). 미정산 예약 수를 돌려준다
create or replace function api.ai_budget_pause_set(p_actor uuid, p_session uuid, p_token text, p_paused boolean, p_reason text)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   boolean;
  v_open  int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_paused is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select c.paused into v_old from core.ai_budget_config c where c.singleton for update;
  update core.ai_budget_config set paused = p_paused, updated_at = now() where singleton;
  select count(*) into v_open from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id where s.reservation_id is null;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, case when p_paused then 'ai.emergency_pause' else 'ai.emergency_resume' end, 'ai_budget_config', null, btrim(p_reason),
          jsonb_build_object('old_paused', v_old, 'new_paused', p_paused, 'unsettled_reservations', v_open));
  return v_open;
end
$$;

-- 일·사용자 한도·동시 호출 상한 설정: 대표만, 금액 0~100,000원·동시 0~1,000, 사유 필수, 감사 기록
create or replace function api.ai_budget_limits_set(p_actor uuid, p_session uuid, p_token text, p_daily int, p_scope_daily int, p_scope_monthly int, p_max_inflight int, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  c       core.ai_budget_config;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_daily is null or p_daily not between 0 and 100000 or p_scope_daily is null or p_scope_daily not between 0 and 100000
     or p_scope_monthly is null or p_scope_monthly not between 0 and 100000 or p_max_inflight is null or p_max_inflight not between 0 and 1000 then
    raise exception 'INVALID_LIMIT' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select * into c from core.ai_budget_config where singleton for update;
  update core.ai_budget_config set daily_limit_krw = p_daily, scope_daily_limit_krw = p_scope_daily, scope_monthly_limit_krw = p_scope_monthly, max_inflight = p_max_inflight, updated_at = now()
   where singleton;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ai.budget_limits_set', 'ai_budget_config', null, btrim(p_reason),
          jsonb_build_object('old', jsonb_build_object('daily', c.daily_limit_krw, 'scope_daily', c.scope_daily_limit_krw, 'scope_monthly', c.scope_monthly_limit_krw, 'max_inflight', c.max_inflight),
                             'new', jsonb_build_object('daily', p_daily, 'scope_daily', p_scope_daily, 'scope_monthly', p_scope_monthly, 'max_inflight', p_max_inflight)));
end
$$;

-- 관리자 조회도 같은 사용액 계산(불확실·조정 포함)을 쓴다. 반환 형식은 0013과 같다
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
           (select x.month_all from core.ai_spent(v_month, (now() at time zone 'Asia/Seoul')::date, null) x)::int,
           (select count(*) from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id
             where u.month = v_month and (s.reservation_id is null or (s.kind = 'uncertain'
               and not exists (select 1 from core.ai_usage_adjustments a where a.reservation_id = u.id))))::int;
end
$$;

commit;
