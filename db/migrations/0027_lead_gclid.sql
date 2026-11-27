-- 0027: 광고 클릭 식별값(gclid) 접수 귀속 (PM 11/24 광고 사전검증 8번). 실제 Google Ads 호출·전송 없음. **운영 적용은 PM 승인 전 금지.**
--  - pii.lead_clicks: 접수(리드)당 gclid 1개(첫 유입 우선, 덮어쓰기 없음). gclid는 온라인 식별정보로 보고 개인정보 스키마(pii)에 둔다.
--  - api.lead_gclid_attach: create_lead 뒤 같은 트랜잭션에서 호출. 서버 서명(['gclid', 요청 키, 연락처 HMAC, gclid])이 있어야 기록한다.
--    대상은 followup_request와 같은 판정(같은 연락처의 중복 기간 안 최신 리드, 같은 잠금) — 재문의도 처음 리드에 귀속된다.
--  - 형식: 영문·숫자·'_'·'-' 10~200자, 영문 1자 이상, 숫자 9자리 이상 연속 금지(전화번호 등 개인정보 혼입 차단). 어긋나면 기록하지 않는다(접수는 막지 않음).
--  - 보존: 접수 정보 파기(purge_customer_internal) 때 함께 삭제, 그와 별도로 수집 후 90일이 지나면 purge_expired가 삭제한다.
--  - create_lead(서명·본문 고정, catalog_audit md5)는 바꾸지 않는다.
begin;

create table pii.lead_clicks (
  lead_id     uuid primary key references core.leads (id),
  gclid       text not null check (gclid ~ '^[A-Za-z0-9_-]{10,200}$' and gclid ~ '[A-Za-z]' and gclid !~ '[0-9]{9}'),
  captured_at timestamptz not null default now()
);
create index lead_clicks_captured on pii.lead_clicks (captured_at);

-- 수정 금지(첫 유입 값 보존). 삭제는 파기 함수(소유자 권한)만 한다
create or replace function core.lead_clicks_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'LEAD_CLICK_IMMUTABLE' using errcode = '42501';
end
$$;
create trigger lead_clicks_guard before update on pii.lead_clicks for each row execute function core.lead_clicks_guard();

create or replace function api.lead_gclid_attach(p_token text, p_idempotency_key text, p_phone_hmac text, p_gclid text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_window int;
  v_lead   uuid;
begin
  if not security.verify_token('lead', p_token, array['gclid', p_idempotency_key, p_phone_hmac, p_gclid]) then
    raise exception 'INVALID_SIGNATURE' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9-]{16,64}$'
     or p_phone_hmac is null or p_phone_hmac !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_gclid is null or p_gclid !~ '^[A-Za-z0-9_-]{10,200}$' or p_gclid !~ '[A-Za-z]' or p_gclid ~ '[0-9]{9}' then
    return 'invalid';  -- 형식 밖 값은 저장하지 않는다(접수는 계속)
  end if;
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
  insert into pii.lead_clicks (lead_id, gclid) values (v_lead, p_gclid) on conflict (lead_id) do nothing;
  return case when found then 'attached' else 'kept_first' end;
end
$$;

-- 파기: 0002 본문 그대로 + 클릭 식별값 삭제 1줄(리드 연결을 끊기 전에)
create or replace function core.purge_customer_internal(p_lead_id uuid, p_actor uuid, p_reason text)
returns void
language plpgsql set search_path = '' as $$
declare
  v_customer uuid;
begin
  select l.customer_id into v_customer from core.leads l where l.id = p_lead_id for update;
  if v_customer is null then
    return;
  end if;
  delete from pii.lead_clicks where lead_id in (select l.id from core.leads l where l.customer_id = v_customer);  -- 0027
  update core.leads
     set customer_id = null, name_masked = '파기됨', phone_last4 = '0000',
         contact_time = null, purged_at = now(), updated_at = now()
   where customer_id = v_customer;
  delete from pii.customers where id = v_customer;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason)
  values (p_actor, 'pii.purge', 'lead', p_lead_id, p_reason);
end
$$;

-- 보존 기간 만료 파기: 0002 본문 그대로 + 수집 후 90일 지난 클릭 식별값 삭제
create or replace function core.purge_expired() returns int
language plpgsql set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  delete from pii.lead_clicks where captured_at < now() - interval '90 days';  -- 0027
  for r in
    select l.id from core.leads l join pii.customers c on c.id = l.customer_id
    where c.retention_until < now() and l.status <> 'converted'
    limit 1000
  loop
    perform core.purge_customer_internal(r.id, null, 'retention_expired');
    n := n + 1;
  end loop;
  return n;
end
$$;

commit;
