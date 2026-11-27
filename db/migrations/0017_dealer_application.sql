-- 0017: 총판 전달용 신청서 — 암호화 저장·열람·전달 이력 (PM 11/21). 접수 개방·외부 호출 없음.
--  - pii.lead_applications: 고객이 AI 상담 도우미에서 답한 가입 정보(설치 주소 등)를 서버가 암호화한 본문 + 범주형 요약(평문, 개인정보 아님).
--    고객 삭제(파기) 시 pii.customers와 함께 연쇄 삭제된다. 주민등록번호·자동이체·계좌정보는 어떤 컬럼에도 없다.
--  - api.application_save: 접수 코드가 api.create_lead와 '같은 트랜잭션'에서 호출한다(서버 서명 필수). 리드가 만들어지지 않은 요청(중복 문의)은 저장하지 않는다.
--  - api.dealer_packet_get: MVP는 대표(owner)만. 사유는 고정 코드(dealer_handoff·content_check·correction), 기존 연락처 열람과 같은 시간당 30회 제한·감사('pii.reveal')와 전달 이력('viewed') 기록.
--  - api.dealer_packet_status: 개인정보 없이 준비 상태(요약 누락 목록·고객별 고지 노출 기록) 확인.
--  - api.handoff_record / handoff_list(대표만): 복사·전달 완료 기록(추가 전용)과 조회. 전달 완료는 먼저 열람한 뒤에만, 메모(총판명 등) 필수.
begin;

create table if not exists pii.lead_applications (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references pii.customers(id) on delete cascade,
  lead_id     uuid not null unique references core.leads(id),
  payload_enc text not null check (payload_enc ~ '^v[0-9]+:'),
  summary     jsonb not null check (jsonb_typeof(summary) = 'object'),
  created_at  timestamptz not null default now()
);

create table if not exists core.dealer_handoffs (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references core.leads(id),
  event      text not null check (event in ('viewed', 'copied', 'sent')),
  note       text check (note is null or length(note) <= 200),
  actor_id   uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists dealer_handoffs_lead on core.dealer_handoffs (lead_id, created_at desc);

create or replace function core.dealer_handoffs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'HANDOFF_IMMUTABLE' using errcode = '42501';
end
$$;
drop trigger if exists dealer_handoffs_guard on core.dealer_handoffs;
create trigger dealer_handoffs_guard before update or delete on core.dealer_handoffs
  for each row execute function core.dealer_handoffs_guard();
drop trigger if exists dealer_handoffs_no_truncate on core.dealer_handoffs;
create trigger dealer_handoffs_no_truncate before truncate on core.dealer_handoffs
  for each statement execute function core.block_truncate();

create or replace function api.application_save(p_token text, p_idempotency_key text, p_payload_enc text, p_summary text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_lead     uuid;
  v_customer uuid;
  v_id       uuid;
begin
  if not security.verify_token('lead', p_token, array['application', p_idempotency_key, p_payload_enc, p_summary]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9-]{16,64}$'
     or p_payload_enc is null or p_payload_enc !~ '^v[0-9]+:' or length(p_payload_enc) > 4000
     or p_summary is null or length(p_summary) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  begin
    if jsonb_typeof(p_summary::jsonb) <> 'object' then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  exception when invalid_text_representation then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end;
  select l.id, l.customer_id into v_lead, v_customer from core.leads l where l.idempotency_key = p_idempotency_key;
  if v_lead is null or v_customer is null then
    return 'skipped';   -- 리드가 만들어지지 않은 요청(같은 연락처 재문의 등)은 저장하지 않는다
  end if;
  insert into pii.lead_applications (customer_id, lead_id, payload_enc, summary)
  values (v_customer, v_lead, p_payload_enc, p_summary::jsonb)
  on conflict (lead_id) do nothing
  returning id into v_id;
  if v_id is null then
    return 'exists';
  end if;
  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('application.save', 'lead', v_lead, jsonb_build_object('answered', p_summary::jsonb -> 'answered', 'missing', coalesce(jsonb_array_length(p_summary::jsonb -> 'missing'), 0)));
  return 'saved';
end
$$;

drop function if exists api.dealer_packet_get(uuid, uuid, text, uuid, text);
create or replace function api.dealer_packet_get(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_reason text)
returns table (name_enc text, phone_enc text, payload_enc text, summary jsonb, interest text, contact_time text, created_at timestamptz, notice_version text, notice_keys text[])
language plpgsql security definer set search_path = '' as $$
declare
  v_staff    core.staff;
  v_customer uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);   -- MVP: 대표만(최소 권한)
  -- 사유는 고정 코드만 받는다(감사 로그에 자유 입력 문장·개인정보가 들어가지 않게)
  if p_reason is null or p_reason not in ('dealer_handoff', 'content_check', 'correction') then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if (select count(*) from core.audit_logs a
       where a.actor_id = v_staff.user_id and a.action = 'pii.reveal' and a.at > now() - interval '1 hour') >= 30 then
    raise exception 'REVEAL_RATE_LIMITED' using errcode = '54000';
  end if;
  select l.customer_id into v_customer from core.leads l where l.id = p_lead_id and l.customer_id is not null;
  if v_customer is null then
    raise exception 'FORBIDDEN' using errcode = '42501';   -- 없음·파기됨을 구분하지 않는다
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'pii.reveal', 'lead', p_lead_id, p_reason, jsonb_build_object('via', 'dealer_packet'));
  insert into core.dealer_handoffs (lead_id, event, note, actor_id) values (p_lead_id, 'viewed', null, v_staff.user_id);
  return query
    select c.name_enc, c.phone_enc, a.payload_enc, a.summary, l.interest, l.contact_time, l.created_at,
           ne.doc_version, coalesce(ne.keys, array[]::text[])
    from core.leads l join pii.customers c on c.id = l.customer_id
    left join pii.lead_applications a on a.lead_id = l.id
    left join lateral (
      select e.doc_version, array_agg(distinct e.notice_key order by e.notice_key) as keys
      from pii.notice_exposures e
      where e.customer_id = l.customer_id and e.shown_at between l.created_at - interval '5 minutes' and l.created_at + interval '5 minutes'
      group by e.doc_version order by max(e.shown_at) desc limit 1
    ) ne on true
    where l.id = p_lead_id;
end
$$;
-- 개인정보 없이 준비 상태만 확인(요약의 누락 목록 + 고객별 고지 노출 기록). 전달 완료 기록 직전에 서버가 다시 판정하는 데 쓴다. 열람 이력은 남기지 않는다
create or replace function api.dealer_packet_status(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid)
returns table (summary jsonb, notice_version text, notice_keys text[])
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if not exists (select 1 from core.leads l where l.id = p_lead_id and l.customer_id is not null) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    select a.summary, ne.doc_version, coalesce(ne.keys, array[]::text[])
    from core.leads l
    left join pii.lead_applications a on a.lead_id = l.id
    left join lateral (
      select e.doc_version, array_agg(distinct e.notice_key order by e.notice_key) as keys
      from pii.notice_exposures e
      where e.customer_id = l.customer_id and e.shown_at between l.created_at - interval '5 minutes' and l.created_at + interval '5 minutes'
      group by e.doc_version order by max(e.shown_at) desc limit 1
    ) ne on true
    where l.id = p_lead_id;
end
$$;
create or replace function api.handoff_record(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_event text, p_note text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);   -- MVP: 대표만
  if p_event is null or p_event not in ('copied', 'sent') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_event = 'sent' and length(btrim(coalesce(p_note, ''))) not between 2 and 30 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  -- 메모는 총판 이름 정도만: 길이 제한, 전화·계좌·주민번호 같은 긴 숫자열·이메일 거부(감사 로그에 개인정보가 남지 않게)
  if p_note is not null and (length(p_note) > 30 or p_note ~ '[0-9]{4,}' or p_note ~ '[@]') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from core.leads l where l.id = p_lead_id and l.customer_id is not null) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from core.dealer_handoffs h where h.lead_id = p_lead_id and h.event = 'viewed') then
    raise exception 'PACKET_NOT_VIEWED' using errcode = '22023';
  end if;
  insert into core.dealer_handoffs (lead_id, event, note, actor_id) values (p_lead_id, p_event, nullif(btrim(coalesce(p_note, '')), ''), v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'handoff.' || p_event, 'lead', p_lead_id, null, jsonb_build_object('event', p_event));
end
$$;
create or replace function api.handoff_list(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid)
returns table (event text, actor_id uuid, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);   -- MVP: 대표만
  if not exists (select 1 from core.leads l where l.id = p_lead_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query select h.event, h.actor_id, h.note, h.created_at from core.dealer_handoffs h where h.lead_id = p_lead_id order by h.created_at desc, h.id desc limit 100;
end
$$;

commit;
