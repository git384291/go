-- 0023 대표 직접 연락 동의(PM 11/22 ② 13·14): AI 상담이 정확히 답하지 못하면(승인 견적 없음) 고객에게 대표 직접 연락 동의를 묻고,
-- 동의한 고객만 '대표 후속 연락 목록'에 올린다.
-- - api.followup_request: 접수(create_lead)와 같은 트랜잭션, 서버 서명 필수. 같은 연락처의 중복 기간 안 최신 리드에 붙인다(새 접수·재접수 모두).
--   연락처·이름은 받지 않는다(이미 암호화 저장된 리드를 가리킬 뿐). 같은 요청 키 재전송은 'exists'.
-- - api.followup_list / api.followup_done: 대표(owner)만. 목록에는 가린 이름·관심 상품·연락 희망 시간만, 연락처 원문은 기존 reveal_contact(사유·감사)로만.
-- - 기록은 추가 전용(요청·완료 이벤트), 감사 로그에는 개인정보 원문 없음.
begin;

create table if not exists core.lead_followups (
  id              bigint generated always as identity primary key,
  lead_id         uuid not null references core.leads(id),
  event           text not null check (event in ('requested', 'done')),
  idempotency_key text unique check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9-]{16,64}$'),
  privacy_version text check (privacy_version is null or length(privacy_version) between 1 and 40),
  actor_id        uuid references core.staff(user_id),
  created_at      timestamptz not null default now(),
  check ((event = 'requested' and idempotency_key is not null and privacy_version is not null and actor_id is null)
      or (event = 'done' and idempotency_key is null and actor_id is not null))
);
create index if not exists lead_followups_lead on core.lead_followups (lead_id, created_at desc);
alter table core.lead_followups enable row level security;
alter table core.lead_followups force row level security;
drop trigger if exists lead_followups_guard on core.lead_followups;
create trigger lead_followups_guard before update or delete on core.lead_followups for each row execute function core.ad_append_only();
drop trigger if exists lead_followups_no_truncate on core.lead_followups;
create trigger lead_followups_no_truncate before truncate on core.lead_followups for each statement execute function core.block_truncate();

create or replace function api.followup_request(p_token text, p_idempotency_key text, p_phone_hmac text, p_privacy_version text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_window int;
  v_lead   uuid;
begin
  if not security.verify_token('lead', p_token, array['followup', p_idempotency_key, p_phone_hmac, p_privacy_version]) then
    raise exception 'INVALID_SIGNATURE' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9-]{16,64}$'
     or p_phone_hmac is null or p_phone_hmac !~ '^[0-9a-f]{64}$'
     or p_privacy_version is null or length(p_privacy_version) not between 1 and 40 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if exists (select 1 from core.lead_followups f where f.idempotency_key = p_idempotency_key) then
    return 'exists';
  end if;
  -- create_lead·application_amend와 같은 잠금·같은 판정(같은 연락처, 중복 기간 안의 최신 리드)
  perform pg_advisory_xact_lock(hashtextextended('lead:' || p_phone_hmac, 0));
  v_window := coalesce((select (s.value #>> '{}')::int from core.settings s where s.key = 'duplicate_window_days'), 7);
  select l.id into v_lead
  from core.leads l join pii.customers c on c.id = l.customer_id
  where c.phone_hmac = p_phone_hmac and l.created_at > now() - make_interval(days => v_window) and l.purged_at is null
  order by l.created_at desc
  limit 1;
  if v_lead is null then
    return 'skipped';
  end if;
  insert into core.lead_followups (lead_id, event, idempotency_key, privacy_version) values (v_lead, 'requested', p_idempotency_key, p_privacy_version);
  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('followup.request', 'lead', v_lead, jsonb_build_object('privacy_version', p_privacy_version));
  return 'requested';
end
$$;

-- 대기 중 = 마지막 이벤트가 'requested'
create or replace function api.followup_list(p_actor uuid, p_session uuid, p_token text)
returns table (lead_id uuid, name_masked text, interest text, contact_time text, requested_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner']);   -- MVP: 대표만
  return query
  select l.id, l.name_masked, l.interest, l.contact_time, f.created_at
  from (select distinct on (x.lead_id) x.lead_id, x.event, x.created_at from core.lead_followups x order by x.lead_id, x.id desc) f
  join core.leads l on l.id = f.lead_id
  where f.event = 'requested' and l.customer_id is not null and l.purged_at is null
  order by f.created_at asc
  limit 200;
end
$$;

create or replace function api.followup_done(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if not exists (
    select 1 from (select x.event from core.lead_followups x where x.lead_id = p_lead_id order by x.id desc limit 1) f
    where f.event = 'requested') then
    raise exception 'NOT_PENDING' using errcode = '22023';
  end if;
  insert into core.lead_followups (lead_id, event, actor_id) values (p_lead_id, 'done', v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'followup.done', 'lead', p_lead_id, '{}'::jsonb);
end
$$;

commit;
