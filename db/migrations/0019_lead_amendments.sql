-- 0019: 같은 연락처 재접수의 변경 요청(amendment) 기록 (PM 11/22 P1). 접수 개방·외부 호출 없음.
--  - 기존: 7일 안 같은 연락처 재접수는 새 리드를 만들지 않고(create_lead 재문의 처리) 새 신청서 내용을 버렸다(application_save 'skipped').
--  - 이제: 서버가 신청서 내용의 키 해시(content_hmac: 서버 HMAC 키 + 연락처 HMAC 솔트, 원문 복원 불가)를 원본 요약(summary.contentHmac)과 비교한다.
--      같으면 'same'(아무것도 저장 안 함 — 재문의 기록은 create_lead가 이미 남김), 다르면 pii.lead_amendments에 암호화 본문으로 '추가'하고 'amended'.
--  - 원본 신청서·동의·고지 노출 기록은 건드리지 않는다(덮어쓰기·자동 반영 없음). 변경 요청은 추가 전용(수정 불가), 고객 파기 시 연쇄 삭제.
--  - 열람: api.application_amendments(대표만). 같은 대표가 방금(10분 안) 신청서를 열람(dealer_packet_get → 'viewed' 기록·pii.reveal 감사)했어야 한다.
--  - 감사 로그에는 개수·누락 수만 남긴다(주소·이메일 등 원문 없음).
begin;

create table if not exists pii.lead_amendments (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references pii.customers(id) on delete cascade,
  lead_id         uuid not null references core.leads(id),
  idempotency_key text not null unique check (idempotency_key ~ '^[A-Za-z0-9-]{16,64}$'),
  payload_enc     text not null check (payload_enc ~ '^v[0-9]+:'),
  summary         jsonb not null check (jsonb_typeof(summary) = 'object'),
  content_hmac    text not null check (content_hmac ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  unique (lead_id, content_hmac)
);
create index if not exists lead_amendments_lead on pii.lead_amendments (lead_id, created_at desc);

create or replace function pii.lead_amendments_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'AMENDMENT_IMMUTABLE' using errcode = '42501';
end
$$;
drop trigger if exists lead_amendments_guard on pii.lead_amendments;
create trigger lead_amendments_guard before update on pii.lead_amendments
  for each row execute function pii.lead_amendments_guard();
drop trigger if exists lead_amendments_no_truncate on pii.lead_amendments;
create trigger lead_amendments_no_truncate before truncate on pii.lead_amendments
  for each statement execute function core.block_truncate();

-- 재접수 신청서 처리(접수 코드가 create_lead·application_save와 같은 트랜잭션에서, application_save가 'skipped'일 때만 호출). 서버 서명 필수.
-- 반환: 'same'(원본 또는 기존 변경 요청과 같은 내용) | 'amended'(변경 요청 1건 추가) | 'skipped'(대상 리드 없음)
create or replace function api.application_amend(p_token text, p_idempotency_key text, p_phone_hmac text, p_payload_enc text, p_summary text, p_content_hmac text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_window   int;
  v_lead     uuid;
  v_customer uuid;
  v_orig     text;
  v_sum      jsonb;
begin
  if not security.verify_token('lead', p_token, array['amendment', p_idempotency_key, p_phone_hmac, p_payload_enc, p_summary, p_content_hmac]) then
    raise exception 'INVALID_SIGNATURE' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9-]{16,64}$'
     or p_phone_hmac is null or p_phone_hmac !~ '^[0-9a-f]{64}$'
     or p_content_hmac is null or p_content_hmac !~ '^[0-9a-f]{64}$'
     or p_payload_enc is null or p_payload_enc !~ '^v[0-9]+:' or p_summary is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  begin
    v_sum := p_summary::jsonb;
    if jsonb_typeof(v_sum) <> 'object' or v_sum->>'contentHmac' is distinct from p_content_hmac then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  exception when invalid_text_representation then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end;
  -- 같은 요청 재전송: 이미 처리된 키
  if exists (select 1 from pii.lead_amendments a where a.idempotency_key = p_idempotency_key) then
    return 'amended';
  end if;
  -- create_lead와 같은 잠금·같은 판정(같은 연락처, 중복 기간 안의 최신 리드)
  perform pg_advisory_xact_lock(hashtextextended('lead:' || p_phone_hmac, 0));
  v_window := coalesce((select (s.value #>> '{}')::int from core.settings s where s.key = 'duplicate_window_days'), 7);
  select l.id, l.customer_id into v_lead, v_customer
  from core.leads l join pii.customers c on c.id = l.customer_id
  where c.phone_hmac = p_phone_hmac and l.created_at > now() - make_interval(days => v_window)
  order by l.created_at desc
  limit 1;
  if v_lead is null then
    return 'skipped';
  end if;
  select a.summary->>'contentHmac' into v_orig from pii.lead_applications a where a.lead_id = v_lead;
  if v_orig = p_content_hmac or exists (select 1 from pii.lead_amendments m where m.lead_id = v_lead and m.content_hmac = p_content_hmac) then
    return 'same';
  end if;
  insert into pii.lead_amendments (customer_id, lead_id, idempotency_key, payload_enc, summary, content_hmac)
  values (v_customer, v_lead, p_idempotency_key, p_payload_enc, v_sum, p_content_hmac);
  insert into core.audit_logs (action, target_type, target_id, detail)
  values ('application.amend', 'lead', v_lead, jsonb_build_object('answered', v_sum -> 'answered', 'missing', coalesce(jsonb_array_length(v_sum -> 'missing'), 0)));
  return 'amended';
end
$$;

-- 변경 요청 열람(대표만). 방금 신청서를 열람(dealer_packet_get: pii.reveal 감사·'viewed' 기록)한 대표만 이어서 볼 수 있다
create or replace function api.application_amendments(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid)
returns table (id uuid, payload_enc text, summary jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if not exists (select 1 from core.leads l where l.id = p_lead_id and l.customer_id is not null) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from core.dealer_handoffs h where h.lead_id = p_lead_id and h.event = 'viewed' and h.actor_id = v_staff.user_id and h.created_at > now() - interval '10 minutes') then
    raise exception 'PACKET_NOT_VIEWED' using errcode = '22023';
  end if;
  return query
    select m.id, m.payload_enc, m.summary, m.created_at from pii.lead_amendments m where m.lead_id = p_lead_id order by m.created_at, m.id;
end
$$;

commit;
