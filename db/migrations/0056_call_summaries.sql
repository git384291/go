-- 0056 AI 통화 요약·고객정보 자동 분류 (PM 11/25 ③)
-- - AI 입력은 개인정보 가린 변환문(transcript_masked)만. AI 결과도 가린 글 검사 통과해야 저장.
-- - 추측 금지: 가입 희망 상품·상담 결과·재연락 일정은 '근거 문장'이 가린 변환문 안에 그대로 있을 때만 값으로 저장.
--   근거가 없으면 unknown / null 이어야 하며, 근거 없는 값은 DB가 거부(UNSUPPORTED_CLAIM).
-- - 버전 기록(추가 전용): AI 결과 = 1판, 관리자 수정 = 새 판(source=staff, 사유 필수). 최신 판이 현재 값.
-- - 녹취 삭제 시 요약 본문·근거를 지운다(분류 값은 통계용으로 남김).
-- - AI 비용은 기존 AI 월 한도 원장(api.ai_budget_hold/confirm/release, app_ai)을 그대로 쓴다. 예약 번호를 작업에 기록.
begin;

create table if not exists core.call_summaries (
  id             bigint generated always as identity primary key,
  call_id        uuid not null references core.calls(id),
  version        int not null check (version between 1 and 1000),
  source         text not null check (source in ('ai', 'staff')),
  product        text not null check (product in ('internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other', 'unknown')),
  outcome        text not null check (outcome in ('interested', 'applied', 'declined', 'no_answer', 'callback_requested', 'undecided', 'unknown')),
  callback_at    timestamptz,
  summary_masked text not null check (length(summary_masked) between 1 and 2000),
  evidence       jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  actor_id       uuid references core.staff(user_id),
  reason         text check (reason is null or length(reason) between 2 and 500),
  wiped_at       timestamptz,
  created_at     timestamptz not null default now(),
  unique (call_id, version),
  check ((source = 'staff') = (actor_id is not null and reason is not null))
);
create index if not exists call_summaries_callback on core.call_summaries (callback_at) where callback_at is not null;

-- 추가 전용. 녹취 삭제 시 본문·근거 지우기만 허용(fideon.call_wipe=on 일 때).
create or replace function core.call_summaries_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'APPEND_ONLY' using errcode = '42501';
  end if;
  if coalesce(current_setting('fideon.call_wipe', true), '') = 'on' and old.wiped_at is null and new.wiped_at is not null
     and new.summary_masked = '[삭제됨]' and new.evidence = '{}'::jsonb
     and (new.id, new.call_id, new.version, new.source, new.product, new.outcome, new.callback_at, new.actor_id, new.reason, new.created_at)
         is not distinct from (old.id, old.call_id, old.version, old.source, old.product, old.outcome, old.callback_at, old.actor_id, old.reason, old.created_at) then
    return new;
  end if;
  raise exception 'APPEND_ONLY' using errcode = '42501';
end
$$;
drop trigger if exists call_summaries_guard on core.call_summaries;
create trigger call_summaries_guard before update or delete on core.call_summaries for each row execute function core.call_summaries_guard();
drop trigger if exists call_summaries_no_truncate on core.call_summaries;
create trigger call_summaries_no_truncate before truncate on core.call_summaries for each statement execute function core.block_truncate();

create or replace function core.call_summaries_on_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.recording_state = 'deleted' and old.recording_state <> 'deleted' then
    perform set_config('fideon.call_wipe', 'on', true);
    update core.call_summaries set summary_masked = '[삭제됨]', evidence = '{}'::jsonb, wiped_at = now()
     where call_id = new.id and wiped_at is null;
    perform set_config('fideon.call_wipe', 'off', true);
  end if;
  return null;
end
$$;
drop trigger if exists call_summaries_on_delete on core.calls;
create trigger call_summaries_on_delete after update of recording_state on core.calls for each row execute function core.call_summaries_on_delete();

-- 값 검사 공용: 형식·가린 글·재연락 시각 범위
create or replace function core.call_summary_check(p_product text, p_outcome text, p_callback timestamptz, p_summary text)
returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_product is null or p_product not in ('internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other', 'unknown')
     or p_outcome is null or p_outcome not in ('interested', 'applied', 'declined', 'no_answer', 'callback_requested', 'undecided', 'unknown')
     or p_summary is null or length(btrim(p_summary)) not between 1 and 2000
     or (p_callback is not null and (p_callback < now() - interval '1 day' or p_callback > now() + interval '180 days')) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if core.call_text_unmasked(p_summary) then
    raise exception 'UNMASKED_PII' using errcode = '22023';
  end if;
end
$$;

-- AI 예약 1건 = 요약 작업 1건(동시 요청도 DB가 막음)
create unique index if not exists call_jobs_ai_reservation on core.call_jobs (ai_reservation) where ai_reservation is not null;

-- 근거 문장 뜻 검사(추측 금지 보강): 값마다 근거에 들어 있어야 하는 낱말. 하나도 없으면 근거로 인정하지 않는다.
create or replace function core.call_evidence_ok(p_kind text, p_value text, p_evidence text)
returns boolean
language sql immutable set search_path = '' as $$
  select length(btrim(coalesce(p_evidence, ''))) >= 4 and exists (
    select 1 from unnest(case
      when p_kind = 'product' and p_value = 'internet_tv'    then array['티비', 'TV', 'tv', '티브이', '테레비', '방송']
      when p_kind = 'product' and p_value = 'internet_phone' then array['전화', '집전화', '인터넷전화']
      when p_kind = 'product' and p_value = 'internet_only'  then array['인터넷']
      when p_kind = 'product' and p_value = 'cctv_security'  then array['CCTV', 'cctv', '씨씨티비', '보안', '카메라']
      when p_kind = 'product' and p_value = 'other'          then array['다른', '기타', '그 외']
      when p_kind = 'outcome' and p_value = 'interested'     then array['관심', '궁금', '알아보', '하고 싶', '해보고']
      when p_kind = 'outcome' and p_value = 'applied'        then array['신청', '가입', '접수']
      when p_kind = 'outcome' and p_value = 'declined'       then array['안 할', '안할', '안 해', '않', '싫', '필요 없', '필요없', '괜찮습니다', '됐어요']
      when p_kind = 'outcome' and p_value = 'no_answer'      then array['부재', '안 받', '통화 불가', '연결이 안']
      when p_kind = 'outcome' and p_value = 'callback_requested' then array['다시', '연락', '전화 주', '전화 줘']
      when p_kind = 'outcome' and p_value = 'undecided'      then array['생각해', '고민', '나중', '상의']
      when p_kind = 'callback'                               then array['내일', '모레', '오늘', '시에', '시쯤', '요일', '다음 주', '다음주', '오전', '오후', '저녁']
      else array[]::text[] end) w
    where strpos(p_evidence, w) > 0)
$$;

-- 요약 작업 가져가기(작업자 전용). 서버는 먼저 AI 비용을 예약(app_ai)하고 그 예약 번호를 넘긴다.
create or replace function api.call_summary_claim(p_ai_reservation bigint)
returns table (job_id bigint, lease_token uuid, call_id uuid, transcript_masked text)
language plpgsql security definer set search_path = '' as $$
declare
  v_job   core.call_jobs;
  v_token uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended('callsummary', 0));   -- 예약 재사용 검사보다 먼저 잠근다(동시 요청 우회 방지)
  if p_ai_reservation is null or not exists (
       select 1 from core.ai_usage_ledger u where u.id = p_ai_reservation
          and not exists (select 1 from core.ai_usage_closures s where s.reservation_id = u.id))
     or exists (select 1 from core.call_jobs j where j.ai_reservation = p_ai_reservation) then
    raise exception 'INVALID_RESERVATION' using errcode = '22023';   -- 정산 안 된 새 예약만(한 작업에 한 번)
  end if;
  perform core.call_jobs_reclaim('summary');
  if not coalesce((select s.summary_enabled from core.call_settings s where s.singleton), false) then
    return;
  end if;
  select j.* into v_job from core.call_jobs j
   where j.kind = 'summary' and j.status = 'queued' and j.next_attempt_at <= now()
   order by j.id limit 1 for update skip locked;
  if not found then
    return;
  end if;
  update core.call_jobs j set status = 'processing', lease_token = v_token, lease_until = now() + interval '5 minutes',
         ai_reservation = p_ai_reservation, updated_at = now()
   where j.id = v_job.id;
  return query select v_job.id, v_token, v_job.call_id, t.transcript_masked
                 from pii.call_transcripts t where t.call_id = v_job.call_id;
end
$$;

-- 요약 완료. 근거 검사. 반환: done | stale | cancelled
create or replace function api.call_summary_complete(p_job bigint, p_lease uuid, p_product text, p_outcome text,
                                                     p_callback_epoch bigint, p_summary text, p_evidence jsonb)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job  core.call_jobs;
  v_text text;
  v_cb   timestamptz := case when p_callback_epoch is null then null else to_timestamp(p_callback_epoch) end;
  k      text;
begin
  perform core.call_summary_check(p_product, p_outcome, v_cb, p_summary);
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_evidence) loop
    if k not in ('product', 'outcome', 'callback') or jsonb_typeof(p_evidence->k) <> 'string'
       or length(p_evidence->>k) not between 2 and 300 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  select * into v_job from core.call_jobs j where j.id = p_job and j.kind = 'summary' for update;
  if not found or v_job.status <> 'processing' or v_job.lease_token is distinct from p_lease or v_job.lease_until < now() then
    return 'stale';
  end if;
  select t.transcript_masked into v_text from pii.call_transcripts t where t.call_id = v_job.call_id;
  if v_text is null then
    update core.call_jobs set status = 'cancelled', lease_token = null, lease_until = null, updated_at = now() where id = p_job;
    return 'cancelled';
  end if;
  -- 추측 금지: 값이 있으면 근거 문장이 변환문에 그대로 있어야 한다. 근거만 있고 값이 없는 것도 거부(불일치)
  if (p_product <> 'unknown') <> (p_evidence ? 'product')
     or (p_outcome <> 'unknown') <> (p_evidence ? 'outcome')
     or (v_cb is not null) <> (p_evidence ? 'callback') then
    raise exception 'UNSUPPORTED_CLAIM' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_evidence) loop
    if strpos(v_text, p_evidence->>k) = 0
       or not core.call_evidence_ok(k, case k when 'product' then p_product when 'outcome' then p_outcome else 'set' end, p_evidence->>k) then
      raise exception 'UNSUPPORTED_CLAIM' using errcode = '22023';
    end if;
  end loop;
  insert into core.call_summaries (call_id, version, source, product, outcome, callback_at, summary_masked, evidence)
  select v_job.call_id, coalesce(max(s.version), 0) + 1, 'ai', p_product, p_outcome, v_cb, btrim(p_summary), p_evidence
    from core.call_summaries s where s.call_id = v_job.call_id
  having not exists (select 1 from core.call_summaries x where x.call_id = v_job.call_id and x.source = 'ai');   -- AI 판은 통화당 1번
  update core.call_jobs set status = 'done', lease_token = null, lease_until = null, last_error = null, updated_at = now() where id = p_job;
  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('call.summary_done', 'call', v_job.call_id, jsonb_build_object('product', p_product, 'outcome', p_outcome, 'callback', v_cb is not null));
  return 'done';
end
$$;

-- 관리자 수정(대표 또는 연결 리드 담당 상담원). 새 판으로 기록.
create or replace function api.call_summary_edit(p_actor uuid, p_session uuid, p_token text, p_call uuid,
                                                 p_product text, p_outcome text, p_callback_epoch bigint, p_summary text, p_reason text)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_cb    timestamptz := case when p_callback_epoch is null then null else to_timestamp(p_callback_epoch) end;
  v_ver   int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor']);
  if not core.call_visible(v_staff, p_call)
     or not exists (select 1 from core.calls c where c.id = p_call and c.recording_state <> 'deleted') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 or length(p_reason) > 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  perform core.call_summary_check(p_product, p_outcome, v_cb, p_summary);
  perform pg_advisory_xact_lock(hashtextextended('callsum:' || p_call::text, 0));
  select coalesce(max(s.version), 0) + 1 into v_ver from core.call_summaries s where s.call_id = p_call;
  insert into core.call_summaries (call_id, version, source, product, outcome, callback_at, summary_masked, actor_id, reason)
  values (p_call, v_ver, 'staff', p_product, p_outcome, v_cb, btrim(p_summary), v_staff.user_id, btrim(p_reason));
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'call.summary_edit', 'call', p_call, btrim(p_reason), jsonb_build_object('version', v_ver));
  return v_ver;
end
$$;

-- 요약 판 목록(수정 화면용). 가린 본문만.
create or replace function api.call_summary_versions(p_actor uuid, p_session uuid, p_token text, p_call uuid)
returns table (version int, source text, product text, outcome text, callback_at timestamptz, summary_masked text,
               evidence jsonb, actor_id uuid, reason text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor']);
  if not core.call_visible(v_staff, p_call) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query select s.version, s.source, s.product, s.outcome, s.callback_at, s.summary_masked, s.evidence, s.actor_id, s.reason, s.created_at
                 from core.call_summaries s where s.call_id = p_call order by s.version;
end
$$;

revoke all on function core.call_evidence_ok(text, text, text) from public;
revoke all on function core.call_summaries_guard(), core.call_summaries_on_delete(),
  core.call_summary_check(text, text, timestamptz, text) from public;

alter table core.call_summaries enable row level security;
alter table core.call_summaries force row level security;

commit;
