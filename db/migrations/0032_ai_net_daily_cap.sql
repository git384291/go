-- 0032: AI 회선별 하루 비용 상한(PM 11/24 결정: 회선별 하루 300원). **운영 적용은 PM 승인 전 금지.**
--  - 목적: 세션을 다시 받아(사용자 키 새로 생성) 사용자별 한도를 초기화하는 우회를 회선 단위로 묶는다.
--  - 회선 키(net_key) = 앱이 만든 HMAC 64자리(IPv4 그대로·IPv6 /64를 서버 키로 HMAC). 원문 IP는 DB에 없다.
--  - 새 4인자 예약 api.ai_budget_hold(비용, 요청 ID, 사용자 키, 회선 키): 회선 키가 있으면 오늘(한국 날짜) 회선 사용액 + 비용 ≤ net_daily_limit_krw.
--    같은 전역 잠금 안이라 동시 요청·여러 서버에서도 원자적. 회선 키 형식이 틀리면 거부(fail-closed).
--  - 기존 3인자 예약은 회선 키 없는 내부 경로(광고 문구 생성 등)용으로 그대로 두되 4인자에 위임한다(본문 한 곳). 상담 경로는 4인자만 쓴다(정적 시험).
--  - 설정 기본값 300원(PM 결정 값). 0 = 회선 키가 있는 호출 금지. 값 변경은 PM 승인 후 별도 마이그레이션.
begin;

alter table core.ai_budget_config
  add column net_daily_limit_krw int not null default 300 check (net_daily_limit_krw between 0 and 1000000);
alter table core.ai_usage_ledger
  add column net_key text check (net_key ~ '^[0-9a-f]{64}$');
create index ai_usage_ledger_net_day on core.ai_usage_ledger (net_key, day) where net_key is not null;

create function api.ai_budget_hold(p_cost int, p_request_id text, p_scope text, p_net text)
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
     or p_scope is null or p_scope !~ '^[0-9a-f]{64}$'
     or (p_net is not null and p_net !~ '^[0-9a-f]{64}$') then
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
  -- 0029: 사용자별 동시 진행 상한(기본 1). 같은 사용자 키의 미정산 예약(최근 2분)이 상한 이상이면 거부. 같은 잠금 안이라 동시 요청에도 원자적
  if (select count(*) from core.ai_usage_ledger u left join core.ai_usage_closures x on x.reservation_id = u.id
       where x.reservation_id is null and u.scope_key = p_scope and u.created_at > v_now - interval '2 minutes') >= c.scope_max_inflight then
    return null;
  end if;
  select * into s from core.ai_spent(v_month, v_day, p_scope);
  if s.month_all + p_cost > c.monthly_limit_krw or s.day_all + p_cost > c.daily_limit_krw
     or s.month_scope + p_cost > c.scope_monthly_limit_krw or s.day_scope + p_cost > c.scope_daily_limit_krw then
    return null;
  end if;
  -- 0032: 회선별 하루 상한(한국 날짜). 같은 회선 키의 오늘 사용액(취소 0·확정 실제·불확실 조정값 또는 예약 전액·미정산 예약 전액) + 이번 비용
  if p_net is not null and (
       select coalesce(sum(case x.kind when 'cancel' then 0 when 'confirm' then x.actual_cost_krw
                                       when 'uncertain' then coalesce(a.actual_cost_krw, x.actual_cost_krw) else u.cost_krw end), 0)
         from core.ai_usage_ledger u
         left join core.ai_usage_closures x on x.reservation_id = u.id
         left join core.ai_usage_adjustments a on a.reservation_id = u.id
        where u.net_key = p_net and u.day = v_day) + p_cost > c.net_daily_limit_krw then
    return null;
  end if;
  insert into core.ai_usage_ledger (month, cost_krw, scope_key, request_id, created_at, net_key)
  values (v_month, p_cost, p_scope, p_request_id, v_now, p_net) returning id into v_id;
  return v_id;
end
$$;


create or replace function api.ai_budget_hold(p_cost int, p_request_id text, p_scope text)
returns bigint
language sql security definer set search_path = '' as $$
  select api.ai_budget_hold(p_cost, p_request_id, p_scope, null::text)
$$;

commit;
