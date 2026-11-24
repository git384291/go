-- 0051 녹취 자동 문자 변환(STT) 작업 큐 (PM 11/25 ②)
-- - 녹취 저장(stored) 시 변환 작업 1건 자동 등록. (통화, 종류) 유일 → 중복 변환 없음.
-- - 작업자(app_call)가 가져갈 때: 변환 스위치 ON + 분당 단가 설정 + 월 한도 안에서 예상 비용을 먼저 예약해야만 가져간다.
--   기본값: 스위치 OFF, 한도 0원 → 외부 비용 0. 켜기는 대표 설정(사유·감사), 실제 활성화는 PM 승인 뒤.
-- - 처리 중 잠금(10분). 잠금이 끝난 작업은 실패 1회로 보고 다시 대기. 최대 3회, 이후 dead.
-- - 완료·실패는 가져갈 때 받은 잠금 토큰이 맞을 때만(늦게 끝난 작업자가 덮어쓰지 못함).
-- - 원문은 암호화(transcript_enc), AI용은 개인정보 가린 글(transcript_masked)만. 가린 글에 전화번호 모양이 남으면 거부.
begin;

create table if not exists core.call_jobs (
  id              bigint generated always as identity primary key,
  call_id         uuid not null references core.calls(id),
  kind            text not null check (kind in ('stt', 'summary')),
  status          text not null default 'queued' check (status in ('queued', 'processing', 'done', 'dead', 'cancelled')),
  attempts        int not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_token     uuid,
  lease_until     timestamptz,
  last_error      text check (last_error is null or last_error ~ '^[A-Z0-9_]{1,40}$'),
  reserved_krw    int not null default 0 check (reserved_krw between 0 and 1000000),
  ai_reservation  bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (call_id, kind),
  check ((status = 'processing') = (lease_token is not null and lease_until is not null))
);
create index if not exists call_jobs_pick on core.call_jobs (kind, status, next_attempt_at);

-- STT 비용 원장(월별). 확정 전에는 예약 금액, 확정 뒤에는 실제 금액으로 합산.
create table if not exists core.call_stt_ledger (
  job_id       bigint not null references core.call_jobs(id),
  attempt      int not null,
  month        text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  reserved_krw int not null check (reserved_krw between 0 and 1000000),
  actual_krw   int check (actual_krw is null or actual_krw between 0 and 1000000),
  created_at   timestamptz not null default now(),
  closed_at    timestamptz,
  primary key (job_id, attempt)
);

create table if not exists pii.call_transcripts (
  call_id           uuid primary key references pii.call_recordings(call_id) on delete cascade,
  transcript_enc    text not null check (transcript_enc ~ '^v[0-9]+:'),
  transcript_masked text not null check (length(transcript_masked) between 1 and 100000),
  provider          text not null check (provider ~ '^[a-z0-9_]{2,30}$'),
  created_at        timestamptz not null default now()
);

-- 가린 글 검사: 전화번호·주민번호·긴 숫자 모양이 남아 있으면 거부(서버 가림의 추가 방어)
create or replace function core.call_text_unmasked(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p ~ '0[0-9]{1,2}[^0-9]{0,3}[0-9]{3,4}[^0-9]{0,3}[0-9]{4}' or p ~ '[0-9]{6}[^0-9]{0,3}[1-8][0-9]{6}' or p ~ '[0-9]{7,}'
$$;

-- 저장된 녹취는 변환 작업을 자동 등록
create or replace function core.call_jobs_enqueue_stt() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.recording_state = 'stored' then
    insert into core.call_jobs (call_id, kind) values (new.id, 'stt') on conflict (call_id, kind) do nothing;
  end if;
  return null;
end
$$;
drop trigger if exists call_jobs_enqueue_stt on core.calls;
create trigger call_jobs_enqueue_stt after insert on core.calls for each row execute function core.call_jobs_enqueue_stt();

-- 녹취 삭제 시 남은 작업 취소
create or replace function core.call_jobs_on_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.recording_state = 'deleted' and old.recording_state <> 'deleted' then
    update core.call_jobs set status = 'cancelled', lease_token = null, lease_until = null, updated_at = now()
     where call_id = new.id and status in ('queued', 'processing');
  end if;
  return null;
end
$$;
drop trigger if exists call_jobs_on_delete on core.calls;
create trigger call_jobs_on_delete after update of recording_state on core.calls for each row execute function core.call_jobs_on_delete();

-- 잠금 만료 작업 회수: 실패 1회로 계산. 예약 비용은 청구됐을 수 있으므로 예약 금액 그대로 확정(보수적).
create or replace function core.call_jobs_reclaim(p_kind text) returns void
language plpgsql set search_path = '' as $$
begin
  update core.call_stt_ledger l set actual_krw = l.reserved_krw, closed_at = now()
    from core.call_jobs j
   where j.kind = p_kind and j.status = 'processing' and j.lease_until < now()
     and l.job_id = j.id and l.attempt = j.attempts and l.closed_at is null;
  update core.call_jobs j set
      attempts = j.attempts + 1,
      status = case when j.attempts + 1 >= 3 then 'dead' else 'queued' end,
      next_attempt_at = now() + make_interval(mins => (2 ^ (j.attempts + 1))::int),
      last_error = 'LEASE_EXPIRED', lease_token = null, lease_until = null, updated_at = now()
   where j.kind = p_kind and j.status = 'processing' and j.lease_until < now();
end
$$;

create or replace function core.call_stt_month_used(p_month text) returns bigint
language sql stable set search_path = '' as $$
  select coalesce(sum(coalesce(l.actual_krw, l.reserved_krw)), 0)::bigint from core.call_stt_ledger l where l.month = p_month
$$;

-- 변환 작업 가져가기(작업자 전용). 조건 미달·한도 초과면 0행.
create or replace function api.call_stt_claim()
returns table (job_id bigint, lease_token uuid, call_id uuid, storage_path text, audio_sha256 text, key_version text, duration_sec int, reserved_krw int)
language plpgsql security definer set search_path = '' as $$
declare
  v_set   core.call_settings;
  v_job   core.call_jobs;
  v_dur   int;
  v_cost  int;
  v_month text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM');
  v_token uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended('callstt', 0));   -- 한도 판정 직렬화
  perform core.call_jobs_reclaim('stt');
  select * into v_set from core.call_settings s where s.singleton;
  if not v_set.stt_enabled or v_set.stt_price_per_min_krw < 1 or v_set.stt_monthly_cap_krw < 1 then
    return;
  end if;
  select j.* into v_job from core.call_jobs j
   where j.kind = 'stt' and j.status = 'queued' and j.next_attempt_at <= now()
   order by j.id limit 1 for update skip locked;
  if not found then
    return;
  end if;
  select c.duration_sec into v_dur from core.calls c where c.id = v_job.call_id;
  v_cost := greatest(ceil(v_dur / 60.0)::int, 1) * v_set.stt_price_per_min_krw;
  if core.call_stt_month_used(v_month) + v_cost > v_set.stt_monthly_cap_krw then
    return;   -- 한도 초과: 작업은 대기 유지, 외부 호출 없음
  end if;
  insert into core.call_stt_ledger (job_id, attempt, month, reserved_krw) values (v_job.id, v_job.attempts, v_month, v_cost);
  update core.call_jobs j set status = 'processing', lease_token = v_token, lease_until = now() + interval '10 minutes',
         reserved_krw = v_cost, updated_at = now()
   where j.id = v_job.id;
  return query select v_job.id, v_token, v_job.call_id, r.storage_path, r.audio_sha256, r.key_version, v_dur, v_cost
                 from pii.call_recordings r where r.call_id = v_job.call_id;
end
$$;

-- 변환 완료. 반환: done | stale | cancelled
create or replace function api.call_stt_complete(p_job bigint, p_lease uuid, p_transcript_enc text, p_transcript_masked text,
                                                 p_provider text, p_actual_krw int)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job core.call_jobs;
begin
  if p_transcript_enc is null or p_transcript_enc !~ '^v[0-9]+:' or p_transcript_masked is null
     or length(p_transcript_masked) not between 1 and 100000 or p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$'
     or p_actual_krw is null or p_actual_krw not between 0 and 1000000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if core.call_text_unmasked(p_transcript_masked) then
    raise exception 'UNMASKED_PII' using errcode = '22023';
  end if;
  select * into v_job from core.call_jobs j where j.id = p_job and j.kind = 'stt' for update;
  if not found or v_job.status <> 'processing' or v_job.lease_token is distinct from p_lease or v_job.lease_until < now() then
    return 'stale';
  end if;
  update core.call_stt_ledger set actual_krw = p_actual_krw, closed_at = now()
   where job_id = p_job and attempt = v_job.attempts and closed_at is null;
  if not exists (select 1 from pii.call_recordings r where r.call_id = v_job.call_id and r.storage_path is not null) then
    update core.call_jobs set status = 'cancelled', lease_token = null, lease_until = null, updated_at = now() where id = p_job;
    return 'cancelled';
  end if;
  insert into pii.call_transcripts (call_id, transcript_enc, transcript_masked, provider)
  values (v_job.call_id, p_transcript_enc, p_transcript_masked, p_provider)
  on conflict (call_id) do nothing;
  update core.call_jobs set status = 'done', lease_token = null, lease_until = null, last_error = null, updated_at = now() where id = p_job;
  insert into core.call_jobs (call_id, kind) values (v_job.call_id, 'summary') on conflict (call_id, kind) do nothing;
  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('call.stt_done', 'call', v_job.call_id, jsonb_build_object('provider', p_provider, 'cost_krw', p_actual_krw, 'attempt', v_job.attempts + 1));
  return 'done';
end
$$;

-- 변환·요약 실패 공용. 반환: retry | dead | stale
create or replace function api.call_job_fail(p_job bigint, p_lease uuid, p_error text, p_retryable boolean, p_charged_krw int)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job core.call_jobs;
  v_dead boolean;
begin
  if p_error is null or p_error !~ '^[A-Z0-9_]{1,40}$' or p_retryable is null
     or p_charged_krw is null or p_charged_krw not between 0 and 1000000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_job from core.call_jobs j where j.id = p_job for update;
  if not found or v_job.status <> 'processing' or v_job.lease_token is distinct from p_lease or v_job.lease_until < now() then
    return 'stale';
  end if;
  update core.call_stt_ledger set actual_krw = p_charged_krw, closed_at = now()
   where job_id = p_job and attempt = v_job.attempts and closed_at is null;
  v_dead := not p_retryable or v_job.attempts + 1 >= 3;
  update core.call_jobs j set
      attempts = j.attempts + 1,
      status = case when v_dead then 'dead' else 'queued' end,
      next_attempt_at = now() + make_interval(mins => (2 ^ (j.attempts + 1))::int),
      last_error = p_error, lease_token = null, lease_until = null, updated_at = now()
   where j.id = p_job;
  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('call.job_fail', 'call', v_job.call_id, jsonb_build_object('kind', v_job.kind, 'error', p_error, 'dead', v_dead));
  return case when v_dead then 'dead' else 'retry' end;
end
$$;

-- 대표: 실패(dead) 작업 다시 대기열에(사유 필수)
create or replace function api.call_job_requeue(p_actor uuid, p_session uuid, p_token text, p_call uuid, p_kind text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 2 or length(p_reason) > 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  update core.call_jobs j set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, updated_at = now()
   where j.call_id = p_call and j.kind = p_kind and j.status = 'dead'
     and exists (select 1 from core.calls c where c.id = p_call and c.recording_state = 'stored');
  if not found then
    raise exception 'NOT_DEAD' using errcode = '22023';
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'call.job_requeue', 'call', p_call, btrim(p_reason), jsonb_build_object('kind', p_kind));
end
$$;

-- 대표·검토자: 이번 달 STT 사용액·한도·작업 현황
create or replace function api.call_stt_status(p_actor uuid, p_session uuid, p_token text)
returns table (month text, used_krw bigint, cap_krw int, queued bigint, processing bigint, dead bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_month text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM');
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'reviewer']);
  return query select v_month, core.call_stt_month_used(v_month), s.stt_monthly_cap_krw,
    (select count(*) from core.call_jobs j where j.kind = 'stt' and j.status = 'queued'),
    (select count(*) from core.call_jobs j where j.kind = 'stt' and j.status = 'processing'),
    (select count(*) from core.call_jobs j where j.kind = 'stt' and j.status = 'dead')
    from core.call_settings s where s.singleton;
end
$$;

revoke all on function core.call_text_unmasked(text), core.call_jobs_enqueue_stt(), core.call_jobs_on_delete(),
  core.call_jobs_reclaim(text), core.call_stt_month_used(text) from public;

alter table core.call_jobs enable row level security;
alter table core.call_jobs force row level security;
alter table core.call_stt_ledger enable row level security;
alter table core.call_stt_ledger force row level security;
alter table pii.call_transcripts enable row level security;
alter table pii.call_transcripts force row level security;

commit;
