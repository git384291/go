-- 0022 광고 정기 감시 중복 실행 방지(PM 11/22 운영 준비). 스케줄러는 같은 회차를 두 번 부르거나 겹쳐 부를 수 있다(Vercel 문서: best effort·중복 가능).
-- - api.ad_monitor_begin(run_id): 끝나지 않은 다른 회차가 10분 안에 시작했으면 false(이번 호출은 아무것도 하지 않고 기록도 남기지 않음).
--   끝남 = 같은 run_id가 담긴 감시 기록(ad_monitor_runs.detail.run_id)이 있음. 10분이 지난 시작은 실패한 회차로 보고 무시한다(새 회차 허용).
-- - 실행 누락은 0021의 MONITOR_STALE(2시간)로 막는다. 테이블은 추가 전용.
begin;

create table if not exists core.ad_monitor_leases (
  run_id     uuid primary key,
  started_at timestamptz not null default now()
);
drop trigger if exists ad_monitor_leases_guard on core.ad_monitor_leases;
create trigger ad_monitor_leases_guard before update or delete on core.ad_monitor_leases for each row execute function core.ad_append_only();
alter table core.ad_monitor_leases enable row level security;
alter table core.ad_monitor_leases force row level security;

create or replace function api.ad_monitor_begin(p_run_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_run_id is null then
    raise exception 'INVALID_MONITOR' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('admonitor:lease', 0));
  if exists (
    select 1 from core.ad_monitor_leases l
    where l.started_at > now() - interval '10 minutes'
      and not exists (select 1 from core.ad_monitor_runs r where r.detail->>'run_id' = l.run_id::text)
  ) or exists (select 1 from core.ad_monitor_leases l where l.run_id = p_run_id) then
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (null, 'ad.monitor_busy', 'ad_monitor', null, 'RUN_IN_PROGRESS', jsonb_build_object('run_id', p_run_id));
    return false;
  end if;
  insert into core.ad_monitor_leases (run_id) values (p_run_id);
  return true;
end
$$;

commit;
