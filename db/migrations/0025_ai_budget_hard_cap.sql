-- 0025 AI 비용 하드 한도 보강(PM 11/24 A·B·C). 실제 AI 호출·운영 데이터 변경 없음. 0011·0012·0013 정의는 지우지 않고 판정만 강화한다.
-- A. 초과 정산 방지: 확정 금액이 예약 금액을 넘거나(초과) 확정 값이 범위 밖·없음(사용량 미확인)이면 core.ai_usage_overages에 남기고,
--    대표가 사유와 함께 해제(api.ai_budget_overage_resolve)할 때까지 새 예약을 모두 거부한다(Fail-Closed).
--    초과 확정은 실제 금액 그대로 사용액에 반영된다(줄여 세지 않음). 범위 밖·미확인은 미정산으로 남아 예약 금액 전액으로 센다.
-- B. 멱등성: 원장에 request_key(고유)·request_hash를 둔다. api.ai_budget_hold_keyed는 같은 키·같은 내용이면 'replay'(새 예약 없음),
--    같은 키·다른 내용이면 'conflict'. 고유 인덱스가 동시 요청에서도 중복을 막는다(판정은 기존과 같은 advisory lock 안).
-- C. 일일 한도: ai_budget_config.daily_limit_krw. null = 월 한도와 같은 값(기존 동작 유지). 날짜는 Asia/Seoul 기준(원장 day).
--    예약 1건마다 월·일 한도를 같은 잠금 안에서 함께 검사한다.
begin;

-- C. 일일 한도(기존 동작 유지: null이면 월 한도를 그대로 쓴다)
alter table core.ai_budget_config add column if not exists daily_limit_krw int check (daily_limit_krw is null or daily_limit_krw between 0 and 1000000);

-- 원장: 서울 날짜 + 멱등성 키. 기존 행은 created_at으로 날짜를 채운다(추가 전용 트리거는 이 채움 동안만 끈다)
-- 롤백(0025_down)은 테이블·열을 남기므로 다시 적용해도 되게 if not exists로 쓴다
alter table core.ai_usage_ledger add column if not exists day date, add column if not exists request_key text, add column if not exists request_hash text;
alter table core.ai_usage_ledger disable trigger ai_usage_ledger_guard;
update core.ai_usage_ledger set day = (created_at at time zone 'Asia/Seoul')::date where day is null;
alter table core.ai_usage_ledger enable trigger ai_usage_ledger_guard;
alter table core.ai_usage_ledger alter column day set default ((now() at time zone 'Asia/Seoul')::date), alter column day set not null;
alter table core.ai_usage_ledger drop constraint if exists ai_usage_ledger_request_key_check, drop constraint if exists ai_usage_ledger_request_hash_check;
alter table core.ai_usage_ledger
  add constraint ai_usage_ledger_request_key_check check (request_key is null or request_key ~ '^[A-Za-z0-9-]{16,64}$'),
  add constraint ai_usage_ledger_request_hash_check check ((request_key is null) = (request_hash is null) and (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'));
create unique index if not exists ai_usage_ledger_request_key on core.ai_usage_ledger (request_key) where request_key is not null;
create index if not exists ai_usage_ledger_day on core.ai_usage_ledger (day);

-- A. 초과·미확인 정산 기록(추가 전용) + 대표 해제 기록(추가 전용)
create table if not exists core.ai_usage_overages (
  id             bigint generated always as identity primary key,
  reservation_id bigint not null unique references core.ai_usage_ledger (id),
  reserved_krw   int not null,
  actual_krw     int,             -- null = 사용량 미확인(범위 밖 값 포함)
  created_at     timestamptz not null default now()
);
create table if not exists core.ai_overage_resolutions (
  overage_id  bigint primary key references core.ai_usage_overages (id),
  resolved_by uuid not null,
  reason      text not null check (length(reason) between 2 and 500),
  created_at  timestamptz not null default now()
);
create or replace trigger ai_usage_overages_guard before update or delete on core.ai_usage_overages for each row execute function core.ad_ai_guard();
create or replace trigger ai_overage_resolutions_guard before update or delete on core.ai_overage_resolutions for each row execute function core.ad_ai_guard();
alter table core.ai_usage_overages enable row level security, force row level security;
alter table core.ai_overage_resolutions enable row level security, force row level security;

-- 예약(멱등): 결과 = reserved | replay | conflict | invalid | overage_lock | monthly_limit | daily_limit. hold_id는 reserved일 때만.
create or replace function api.ai_budget_hold_keyed(p_cost int, p_key text, p_hash text)
returns table (hold_id bigint, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_now   timestamptz := now();
  v_month text := to_char(v_now at time zone 'Asia/Seoul', 'YYYY-MM');
  v_day   date := (v_now at time zone 'Asia/Seoul')::date;
  v_mlim  int;
  v_dlim  int;
  v_mused bigint;
  v_dused bigint;
  v_hash  text;
  v_id    bigint;
begin
  if p_cost is null or p_cost not between 1 and 1000
     or (p_key is null) <> (p_hash is null)
     or (p_key is not null and (p_key !~ '^[A-Za-z0-9-]{16,64}$' or p_hash !~ '^[0-9a-f]{64}$')) then
    return query select null::bigint, 'invalid'::text; return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  if p_key is not null then
    select u.request_hash into v_hash from core.ai_usage_ledger u where u.request_key = p_key;
    if found then
      return query select null::bigint, (case when v_hash = p_hash then 'replay' else 'conflict' end)::text; return;
    end if;
  end if;
  if exists (select 1 from core.ai_usage_overages o
              where not exists (select 1 from core.ai_overage_resolutions r where r.overage_id = o.id)) then
    return query select null::bigint, 'overage_lock'::text; return;
  end if;
  select c.monthly_limit_krw, coalesce(c.daily_limit_krw, c.monthly_limit_krw) into v_mlim, v_dlim from core.ai_budget_config c where c.singleton;
  select coalesce(sum(t.c), 0), coalesce(sum(t.c) filter (where t.day = v_day), 0) into v_mused, v_dused
    from (select u.day, case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end as c
            from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id
           where u.month = v_month) t;
  if v_mlim is null or v_mused + p_cost > v_mlim then
    return query select null::bigint, 'monthly_limit'::text; return;
  end if;
  if v_dlim is null or v_dused + p_cost > v_dlim then
    return query select null::bigint, 'daily_limit'::text; return;
  end if;
  insert into core.ai_usage_ledger (month, day, cost_krw, request_key, request_hash)
  values (v_month, v_day, p_cost, p_key, p_hash) returning id into v_id;
  return query select v_id, 'reserved'::text;
end
$$;

-- 기존 예약 함수(키 없음)도 같은 판정(월·일 한도·초과 잠금)을 쓴다. 반환 형식은 그대로(번호 또는 null)
create or replace function api.ai_budget_hold(p_cost int)
returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  return (select h.hold_id from api.ai_budget_hold_keyed(p_cost, null, null) h);
end
$$;

-- 확정: 0~1,000원 정수만 정산한다(기존 계약). 예약 금액 초과면 실제 금액으로 정산하고 초과 기록 → 새 예약 잠금.
-- 범위 밖·null(사용량 미확인)은 정산하지 않고(예약 금액 전액으로 셈) 미확인 기록 → 새 예약 잠금. 반환값은 기존과 같다.
create or replace function api.ai_budget_confirm(p_id bigint, p_actual int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_cost int;
begin
  if p_id is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select u.cost_krw into v_cost from core.ai_usage_ledger u where u.id = p_id;
  if not found then
    return false;
  end if;
  if exists (select 1 from core.ai_usage_closures s where s.reservation_id = p_id) then
    return false;   -- 이미 정산됨(예약당 1번)
  end if;
  if p_actual is null or p_actual not between 0 and 1000 then
    insert into core.ai_usage_overages (reservation_id, reserved_krw, actual_krw) values (p_id, v_cost, null)
    on conflict (reservation_id) do nothing;
    return false;
  end if;
  insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) values (p_id, 'confirm', p_actual);
  if p_actual > v_cost then
    insert into core.ai_usage_overages (reservation_id, reserved_krw, actual_krw) values (p_id, v_cost, p_actual)
    on conflict (reservation_id) do nothing;
  end if;
  return true;
end
$$;

-- 관리자: 일 한도 설정(대표만, 사유 필수, 감사 기록). null = 월 한도와 같게
create or replace function api.ai_budget_daily_limit_set(p_actor uuid, p_session uuid, p_token text, p_limit int, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_limit is not null and p_limit not between 0 and 100000 then
    raise exception 'INVALID_LIMIT' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select c.daily_limit_krw into v_old from core.ai_budget_config c where c.singleton for update;
  update core.ai_budget_config set daily_limit_krw = p_limit, updated_at = now() where singleton;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ai.daily_limit_set', 'ai_budget_config', null, btrim(p_reason), jsonb_build_object('old_limit_krw', v_old, 'new_limit_krw', p_limit));
end
$$;

-- 관리자: 오늘(서울) 사용액·일 한도(실제 적용 값)·해제 안 된 초과 건수
create or replace function api.ai_budget_guard_get(p_actor uuid, p_session uuid, p_token text)
returns table (day date, daily_limit_krw int, used_today_krw int, open_overages int)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_day   date := (now() at time zone 'Asia/Seoul')::date;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  return query
    select v_day,
           (select coalesce(c.daily_limit_krw, c.monthly_limit_krw) from core.ai_budget_config c where c.singleton),
           coalesce((select sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end)
                       from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id = u.id where u.day = v_day), 0)::int,
           (select count(*) from core.ai_usage_overages o
             where not exists (select 1 from core.ai_overage_resolutions r where r.overage_id = o.id))::int;
end
$$;

-- 관리자: 초과 잠금 해제(대표만, 사유 필수, 감사 기록). 해제된 건수를 돌려준다. 사용액은 바뀌지 않는다
create or replace function api.ai_budget_overage_resolve(p_actor uuid, p_session uuid, p_token text, p_reason text)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_n     int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  insert into core.ai_overage_resolutions (overage_id, resolved_by, reason)
  select o.id, v_staff.user_id, btrim(p_reason) from core.ai_usage_overages o
   where not exists (select 1 from core.ai_overage_resolutions r where r.overage_id = o.id);
  get diagnostics v_n = row_count;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ai.overage_resolve', 'ai_usage_overages', null, btrim(p_reason), jsonb_build_object('resolved', v_n));
  return v_n;
end
$$;

commit;
