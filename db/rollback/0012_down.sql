-- 0012 롤백: 상담 집계·AI 정산 객체 삭제. 상담 기록·정산 기록은 삭제 전에 보관 테이블로 옮긴다(덮어쓰지 않음: 이미 있으면 실패).
-- ai_budget_reserve는 0011 정의(정산 없는 단순 합계)로 되돌린다. 복구: 0012 재적용 후 db/rollback/0012_restore.sql. 롤백 뒤 zz_grants.sql도 이전 버전으로 실행.
begin;
create table core.consult_events_rollback_archive as table core.consult_events;
create table core.ai_usage_closures_rollback_archive as table core.ai_usage_closures;
do $$
declare t text;
begin
  foreach t in array array['consult_events_rollback_archive', 'ai_usage_closures_rollback_archive'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('create policy fideon_api_all on core.%I to fideon_api using (true) with check (true)', t);
    execute format('revoke all on core.%I from public', t);
  end loop;
end $$;
drop function if exists api.ai_budget_release(bigint);
drop function if exists api.ai_budget_confirm(bigint, int);
create or replace function api.ai_budget_reserve(p_cost int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_month text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM');
  v_limit int;
  v_used  int;
begin
  if p_cost is null or p_cost not between 1 and 1000 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aiusage', 0));
  select c.monthly_limit_krw into v_limit from core.ai_budget_config c where c.singleton;
  select coalesce(sum(u.cost_krw), 0) into v_used from core.ai_usage_ledger u where u.month = v_month;
  if v_limit is null or v_used + p_cost > v_limit then
    return false;
  end if;
  insert into core.ai_usage_ledger (month, cost_krw) values (v_month, p_cost);
  return true;
end
$$;
drop function if exists api.ai_budget_hold(int);
drop function if exists api.ad_funnel_full(uuid, uuid, text, date, date);
drop function if exists api.consult_event_record(text, text);
drop table core.ai_usage_closures;
drop table core.consult_events;
commit;
