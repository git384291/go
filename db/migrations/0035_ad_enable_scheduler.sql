-- 0035 광고 자동 스케줄러 + PAUSED → ENABLED 안전 자동전환(PM 11/25 ②③). 가상 DB·모의 플랫폼 시험만. 실제 Google Ads ENABLED 호출·광고비 없음.
-- 흐름: 대표가 launch(캠페인 PAUSED 생성·예산 예약) 뒤 '활성화 예약'을 만든다(키워드·소재·CPC를 명시해 승인) →
--       외부 스케줄러(HTTP 호출, 특정 클라우드 비종속)가 실행 시각 이후 예약 1건을 잡아(동시 실행은 1건만) → DB 최종 판정 → 매체 상태 확인(PAUSED) →
--       활성화(모의만) → 다시 읽어 ENABLED 확인. 어느 단계든 불명·실패면 중지·경고(성공으로 표시하지 않음).
-- - 키워드: 대표가 PM 승인 키워드만 등록(EXACT만). 등록이 없으면 예약 불가. 등록 철회 시 그 키워드를 쓰는 활성 예약·활성 캠페인의 예산 승인을 철회 → 정기 감시가 중지.
-- - CPC 정책: 기본 0원(미설정) = 예약 불가. 대표가 PM 승인 값으로 설정(사유·감사).
-- - 예산: launch 때 이미 날짜별 최대 청구액이 예약돼 있다(0021). 실행 시점에 승인·기간·월 예산(0034)·계정 한도·정기 감시·중지 실패 경고를 다시 확인.
begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_ad_scheduler') then
    create role app_ad_scheduler nologin;  -- 예약 실행 함수만. 테이블 권한 없음
  end if;
end $$;
grant app_ad_scheduler to app_server;

create table if not exists core.ad_cpc_policy (
  id          smallint primary key default 1 check (id = 1),
  max_cpc_krw int not null default 0 check (max_cpc_krw between 0 and 10000),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
insert into core.ad_cpc_policy (id) values (1) on conflict (id) do nothing;

create table if not exists core.ad_keyword_registry (
  keyword     text primary key check (keyword ~ '^[가-힣A-Za-z0-9]+( [가-힣A-Za-z0-9]+)*$' and length(keyword) <= 80),
  match_type  text not null default 'EXACT' check (match_type = 'EXACT'),
  state       text not null check (state in ('approved', 'revoked')),
  updated_by  uuid not null,
  reason      text not null check (length(reason) between 2 and 500),
  updated_at  timestamptz not null default now()
);

create table if not exists core.ad_enable_jobs (
  id                 uuid primary key default gen_random_uuid(),
  campaign_key       text not null check (campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  launch_request_key text not null check (launch_request_key ~ '^[A-Za-z0-9-]{16,64}$'),
  run_at             timestamptz not null,
  keywords           text[] not null check (cardinality(keywords) between 1 and 10),
  creative_sha256    text not null check (creative_sha256 ~ '^[0-9a-f]{64}$'),
  max_cpc_krw        int  not null check (max_cpc_krw between 1 and 10000),
  state              text not null default 'scheduled' check (state in ('scheduled', 'running', 'enabled', 'blocked', 'failed', 'unknown', 'cancelled')),
  run_id             uuid,
  claimed_at         timestamptz,
  result_code        text check (result_code is null or result_code ~ '^[A-Z_]{2,40}$'),
  created_by         uuid not null,
  reason             text not null check (length(reason) between 2 and 500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists ad_enable_jobs_one_open on core.ad_enable_jobs (campaign_key) where state in ('scheduled', 'running', 'unknown');
create index if not exists ad_enable_jobs_due on core.ad_enable_jobs (run_at) where state = 'scheduled';
create or replace function core.ad_no_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'AD_NO_DELETE' using errcode = '42501';
end
$$;
drop trigger if exists ad_cpc_policy_guard on core.ad_cpc_policy;
create trigger ad_cpc_policy_guard before delete on core.ad_cpc_policy for each row execute function core.ad_no_delete();
drop trigger if exists ad_keyword_registry_guard on core.ad_keyword_registry;
create trigger ad_keyword_registry_guard before delete on core.ad_keyword_registry for each row execute function core.ad_no_delete();
drop trigger if exists ad_enable_jobs_guard on core.ad_enable_jobs;
create trigger ad_enable_jobs_guard before delete on core.ad_enable_jobs for each row execute function core.ad_no_delete();
alter table core.ad_cpc_policy enable row level security;
alter table core.ad_cpc_policy force row level security;
alter table core.ad_keyword_registry enable row level security;
alter table core.ad_keyword_registry force row level security;
alter table core.ad_enable_jobs enable row level security;
alter table core.ad_enable_jobs force row level security;

-- CPC 정책 설정(대표만, 사유·변경 전후 감사). 0 = 미설정(예약 불가)
create or replace function api.ad_cpc_policy_set(p_actor uuid, p_session uuid, p_token text, p_max int, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_old   int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_max is null or p_max not between 0 and 10000 or p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'INVALID_CPC_POLICY' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  select max_cpc_krw into v_old from core.ad_cpc_policy where id = 1 for update;
  update core.ad_cpc_policy set max_cpc_krw = p_max, updated_by = v_staff.user_id, updated_at = now() where id = 1;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.cpc_policy_set', 'ad_cpc_policy', null, btrim(p_reason), jsonb_build_object('old', v_old, 'new', p_max));
  return jsonb_build_object('max_cpc_krw', p_max);
end
$$;

-- 키워드 등록(대표가 PM 승인 키워드만, EXACT). 같은 키워드 재등록은 승인 상태로 갱신
create or replace function api.ad_keyword_approve(p_actor uuid, p_session uuid, p_token text, p_keyword text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_keyword is null or p_keyword !~ '^[가-힣A-Za-z0-9]+( [가-힣A-Za-z0-9]+)*$' or length(p_keyword) > 80
     or p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'INVALID_KEYWORD' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  insert into core.ad_keyword_registry (keyword, state, updated_by, reason) values (p_keyword, 'approved', v_staff.user_id, btrim(p_reason))
  on conflict (keyword) do update set state = 'approved', updated_by = excluded.updated_by, reason = excluded.reason, updated_at = now();
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.keyword_approve', 'ad_keyword', null, btrim(p_reason), jsonb_build_object('keyword', p_keyword, 'match_type', 'EXACT'));
end
$$;

-- 키워드 철회: 그 키워드를 쓰는 예약은 취소, 이미 활성화된(enabled) 캠페인은 예산 승인 철회 → 새 지출 차단 + 정기 감시가 중지(NO_ACTIVE_APPROVAL)
create or replace function api.ad_keyword_revoke(p_actor uuid, p_session uuid, p_token text, p_keyword text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff     core.staff;
  v_cancelled int;
  v_revoked   int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_keyword is null or length(p_keyword) > 80 or p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'INVALID_KEYWORD' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  update core.ad_keyword_registry set state = 'revoked', updated_by = v_staff.user_id, reason = btrim(p_reason), updated_at = now() where keyword = p_keyword;
  if not found then
    raise exception 'KEYWORD_NOT_FOUND' using errcode = 'P0002';
  end if;
  update core.ad_enable_jobs set state = 'cancelled', result_code = 'KEYWORD_REVOKED', updated_at = now()
   where state = 'scheduled' and p_keyword = any(keywords);
  get diagnostics v_cancelled = row_count;
  update core.ad_budget_approvals a set state = 'revoked', revoked_by = v_staff.user_id, revoked_at = now(), revoke_reason = '키워드 승인 철회: ' || left(p_keyword, 80)
   where a.state = 'active' and exists (select 1 from core.ad_enable_jobs j where j.campaign_key = a.campaign_key and j.state in ('running', 'enabled', 'unknown') and p_keyword = any(j.keywords));
  get diagnostics v_revoked = row_count;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.keyword_revoke', 'ad_keyword', null, btrim(p_reason),
          jsonb_build_object('keyword', p_keyword, 'cancelled_jobs', v_cancelled, 'revoked_approvals', v_revoked));
  return jsonb_build_object('cancelled_jobs', v_cancelled, 'revoked_approvals', v_revoked);
end
$$;

-- 활성화 판정(예약 생성·실행 공통). 사유 없으면 null(= 허용). 계정 잠금 안에서 부른다
create or replace function core.ad_enable_check(p_campaign text, p_launch_key text, p_keywords text[], p_max_cpc int, p_at timestamptz)
returns text
language plpgsql stable set search_path = '' as $$
declare
  v_today date := (p_at at time zone 'Asia/Seoul')::date;
  v_app   core.ad_budget_approvals;
  v_lim   int := core.ad_month_effective_limit();
  v_run   core.ad_monitor_runs;
  v_end   date;
  v_start date;
begin
  if p_keywords is null or cardinality(p_keywords) not between 1 and 10
     or (select count(distinct lower(replace(k, ' ', ''))) from unnest(p_keywords) k) <> cardinality(p_keywords) then
    return 'KEYWORDS_INVALID';
  end if;
  if exists (select 1 from unnest(p_keywords) k where not exists (
      select 1 from core.ad_keyword_registry r where r.keyword = k and r.state = 'approved' and r.match_type = 'EXACT')) then
    return 'KEYWORD_NOT_APPROVED';
  end if;
  if coalesce((select max_cpc_krw from core.ad_cpc_policy where id = 1), 0) <= 0 then
    return 'CPC_POLICY_UNSET';
  end if;
  if p_max_cpc is null or p_max_cpc < 1 or p_max_cpc > coalesce((select max_cpc_krw from core.ad_cpc_policy where id = 1), 0) then
    return 'CPC_OVER_POLICY';
  end if;
  select * into v_app from core.ad_budget_approvals a where a.campaign_key = p_campaign and a.state = 'active';
  if not found then
    return 'NO_APPROVAL';
  end if;
  if v_app.valid_from > p_at or v_app.valid_until <= p_at then
    return 'APPROVAL_EXPIRED';
  end if;
  if not exists (select 1 from core.ad_launches l where l.campaign_key = p_campaign and l.request_key = p_launch_key and l.state = 'active' and l.external_id is not null) then
    return 'NO_ACTIVE_LAUNCH';
  end if;
  select min(x.serve_date), max(x.serve_date) into v_start, v_end from core.ad_exposure x where x.request_key = p_launch_key;
  if v_end is null or v_today < v_start or v_today > v_end then
    return 'OUTSIDE_WINDOW';  -- 예산이 예약된 집행 기간 밖(기간 전·후)은 활성화 금지
  end if;
  if v_lim <= 0 then
    return 'MONTHLY_BUDGET_UNSET';
  end if;
  if core.ad_account_month(v_today) > v_lim then
    return 'MONTHLY_CAP_EXCEEDED';
  end if;
  if core.ad_account_day(v_today) > 10000 or core.ad_account_total() > 30000 then
    return 'ACCOUNT_CAP_EXCEEDED';
  end if;
  if exists (select 1 from core.ad_alerts al where al.state = 'open') then
    return 'STOP_PENDING';
  end if;
  select * into v_run from core.ad_monitor_runs r order by r.ran_at desc, r.id desc limit 1;
  if v_run.id is null or v_run.ran_at < p_at - interval '2 hours' then
    return 'MONITOR_STALE';
  end if;
  if v_run.ok is not true then
    return 'MONITOR_NOT_OK';
  end if;
  return null;
end
$$;

-- 활성화 예약(대표만): 실행 시각은 지금 이후 3일 안. 예약 시점에도 판정을 통과해야 만든다(시각만 미래). 막히면 만들지 않고 사유를 돌려준다
create or replace function api.ad_enable_schedule(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_launch_key text, p_run_at timestamptz,
    p_keywords text[], p_creative_sha256 text, p_max_cpc int, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff  core.staff;
  v_reason text;
  v_id     uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or p_launch_key is null or p_launch_key !~ '^[A-Za-z0-9-]{16,64}$'
     or p_run_at is null or p_creative_sha256 is null or p_creative_sha256 !~ '^[0-9a-f]{64}$'
     or p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'INVALID_ENABLE' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  if p_run_at <= now() or p_run_at > now() + interval '3 days' then
    v_reason := 'RUN_AT_INVALID';
  elsif exists (select 1 from core.ad_enable_jobs j where j.campaign_key = p_campaign and j.state in ('scheduled', 'running', 'unknown')) then
    v_reason := 'JOB_OPEN';
  else
    -- 실행 시각의 기간 판정은 실행 때 다시 한다. 지금은 키워드·CPC·승인·launch·월 예산·경고만 본다(기간은 실행 시각 기준)
    v_reason := core.ad_enable_check(p_campaign, p_launch_key, p_keywords, p_max_cpc, now());
    if v_reason in ('OUTSIDE_WINDOW', 'MONITOR_STALE', 'MONITOR_NOT_OK') then
      v_reason := null;
    end if;
  end if;
  if v_reason is not null then
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (v_staff.user_id, 'ad.enable_schedule_blocked', 'ad_campaign', null, v_reason, jsonb_build_object('campaign', p_campaign));
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;
  insert into core.ad_enable_jobs (campaign_key, launch_request_key, run_at, keywords, creative_sha256, max_cpc_krw, created_by, reason)
  values (p_campaign, p_launch_key, p_run_at, p_keywords, p_creative_sha256, p_max_cpc, v_staff.user_id, btrim(p_reason))
  returning id into v_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.enable_scheduled', 'ad_enable_job', v_id, btrim(p_reason),
          jsonb_build_object('campaign', p_campaign, 'run_at', p_run_at, 'keywords', p_keywords, 'creative_sha256', p_creative_sha256, 'max_cpc_krw', p_max_cpc));
  return jsonb_build_object('ok', true, 'id', v_id);
end
$$;

-- 예약 취소(대표만, 실행 전 예약만)
create or replace function api.ad_enable_cancel(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_n     int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or p_reason is null or length(btrim(p_reason)) not between 2 and 500 then
    raise exception 'INVALID_ENABLE' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  update core.ad_enable_jobs set state = 'cancelled', result_code = 'CANCELLED', updated_at = now() where campaign_key = p_campaign and state = 'scheduled';
  get diagnostics v_n = row_count;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.enable_cancel', 'ad_campaign', null, btrim(p_reason), jsonb_build_object('campaign', p_campaign, 'cancelled', v_n));
  return jsonb_build_object('cancelled', v_n);
end
$$;

-- 스케줄러: 실행 시각이 지난 예약 1건을 잡는다(여러 서버 동시 호출 → 1건만). 10분 넘게 끝나지 않은 실행은 불명(unknown) + 경고(사람 확인, 자동 재시도 없음)
create or replace function api.ad_sched_claim(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job core.ad_enable_jobs;
  v_ext text;
begin
  if p_run_id is null then
    raise exception 'INVALID_SCHEDULER' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adsched:claim', 0));
  for v_job in select * from core.ad_enable_jobs j where j.state = 'running' and j.claimed_at < now() - interval '10 minutes' for update loop
    update core.ad_enable_jobs set state = 'unknown', result_code = 'RUN_TIMEOUT', updated_at = now() where id = v_job.id;
    if not exists (select 1 from core.ad_alerts al where al.campaign_key = v_job.campaign_key and al.state = 'open') then
      insert into core.ad_alerts (campaign_key, kind, detail, created_by)
      values (v_job.campaign_key, 'stop_failed', jsonb_build_object('trigger', 'scheduler', 'code', 'RUN_TIMEOUT'), '00000000-0000-4000-8000-00000000ad01');
    end if;
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (null, 'ad.enable_unknown', 'ad_enable_job', v_job.id, 'RUN_TIMEOUT', jsonb_build_object('campaign', v_job.campaign_key));
  end loop;
  select * into v_job from core.ad_enable_jobs j where j.state = 'scheduled' and j.run_at <= now() order by j.run_at, j.id limit 1 for update skip locked;
  if not found then
    return jsonb_build_object('job', null);
  end if;
  update core.ad_enable_jobs set state = 'running', run_id = p_run_id, claimed_at = now(), updated_at = now() where id = v_job.id;
  select l.external_id into v_ext from core.ad_launches l where l.request_key = v_job.launch_request_key;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (null, 'ad.enable_claim', 'ad_enable_job', v_job.id, null, jsonb_build_object('campaign', v_job.campaign_key, 'run_id', p_run_id));
  return jsonb_build_object('job', jsonb_build_object('id', v_job.id, 'campaign', v_job.campaign_key, 'external_id', v_ext));
end
$$;

-- 스케줄러: 실행 직전 최종 판정(계정 잠금 안). 예약을 만든 대표가 지금도 활성 대표여야 한다. 막히면 예약은 blocked로 닫힌다
create or replace function api.ad_sched_gate(p_job uuid, p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job    core.ad_enable_jobs;
  v_reason text;
begin
  if p_job is null or p_run_id is null then
    raise exception 'INVALID_SCHEDULER' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));
  select * into v_job from core.ad_enable_jobs j where j.id = p_job for update;
  if not found or v_job.state <> 'running' or v_job.run_id is distinct from p_run_id then
    return jsonb_build_object('decision', 'BLOCK', 'reason', 'JOB_NOT_CLAIMED');
  end if;
  if v_job.run_at > now() then
    v_reason := 'NOT_YET';
  elsif not exists (select 1 from core.staff s where s.user_id = v_job.created_by and s.role = 'owner' and s.active) then
    v_reason := 'APPROVER_INACTIVE';
  else
    v_reason := core.ad_enable_check(v_job.campaign_key, v_job.launch_request_key, v_job.keywords, v_job.max_cpc_krw, now());
  end if;
  if v_reason is not null then
    update core.ad_enable_jobs set state = 'blocked', result_code = v_reason, updated_at = now() where id = p_job;
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (null, 'ad.enable_blocked', 'ad_enable_job', p_job, v_reason, jsonb_build_object('campaign', v_job.campaign_key));
    return jsonb_build_object('decision', 'BLOCK', 'reason', v_reason);
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (null, 'ad.enable_allow', 'ad_enable_job', p_job, null,
          jsonb_build_object('campaign', v_job.campaign_key, 'keywords', v_job.keywords, 'max_cpc_krw', v_job.max_cpc_krw, 'approved_by', v_job.created_by));
  return jsonb_build_object('decision', 'ALLOW', 'reason', null, 'keywords', to_jsonb(v_job.keywords), 'max_cpc_krw', v_job.max_cpc_krw, 'creative_sha256', v_job.creative_sha256);
end
$$;

-- 스케줄러: 결과 기록. enabled는 다시 읽어 ENABLED 확인했을 때만. unknown이면 경고(계정 전체 새 지출 차단, 사람 확인)
create or replace function api.ad_sched_finish(p_job uuid, p_run_id uuid, p_state text, p_code text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job core.ad_enable_jobs;
begin
  if p_job is null or p_run_id is null or p_state is null or p_state not in ('enabled', 'failed', 'unknown')
     or (p_code is not null and p_code !~ '^[A-Z_]{2,40}$') then
    raise exception 'INVALID_SCHEDULER' using errcode = '22023';
  end if;
  select * into v_job from core.ad_enable_jobs j where j.id = p_job for update;
  if not found or v_job.state <> 'running' or v_job.run_id is distinct from p_run_id then
    raise exception 'JOB_NOT_CLAIMED' using errcode = '55000';
  end if;
  update core.ad_enable_jobs set state = p_state, result_code = p_code, updated_at = now() where id = p_job;
  if p_state = 'unknown' and not exists (select 1 from core.ad_alerts al where al.campaign_key = v_job.campaign_key and al.state = 'open') then
    insert into core.ad_alerts (campaign_key, kind, detail, created_by)
    values (v_job.campaign_key, 'stop_failed', jsonb_build_object('trigger', 'scheduler', 'code', coalesce(p_code, 'UNKNOWN')), '00000000-0000-4000-8000-00000000ad01');
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (null, 'ad.enable_' || p_state, 'ad_enable_job', p_job, p_code, jsonb_build_object('campaign', v_job.campaign_key));
end
$$;

commit;
