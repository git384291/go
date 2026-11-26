-- 0063_purge_notes_retention.sql — 파기 보완 (PM 11/25 A안·법정 보존 분리)
-- 1) 상담 메모(core.lead_notes, 직원 자유 입력)를 신청·고객 파기 때 함께 삭제
-- 2) 법정 보존 분리: 계약 완료 후 5년(core.legal_hold)만 보존. 5년이 지나면 일반 개인정보처럼 만료·수동 파기 가능.
--    보존 중이어도 계약 완료가 아닌 다른 신청은 api.purge_lead로 따로 파기(고객·계약 신청은 보존).
-- 5년 = 전자상거래법 계약 기록 기준. 바른통신 계약 형태에 적용되는지는 법률 확인 필요(미확인).
begin;

-- 법정 보존 판정: 계약 완료(converted)된 지 5년이 안 된 신청이 있으면 true.
-- 계약 완료 시각 = 상태 이력의 converted 전환 시각(없으면 리드 수정 시각). 보존 기간이 지나면 일반 개인정보와 같이 파기 대상.
create or replace function core.legal_hold(p_customer uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from core.leads l
    where l.customer_id = p_customer and l.status = 'converted'
      and coalesce((select max(h.at) from core.lead_status_history h where h.lead_id = l.id and h.to_status = 'converted'), l.updated_at)
          > now() - interval '5 years')
$$;

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
  -- 0063: 직원 상담 메모(자유 입력, 개인정보가 섞일 수 있음)도 함께 파기
  delete from core.lead_notes n using core.leads l where n.lead_id = l.id and l.customer_id = v_customer;
  update core.leads
     set customer_id = null, name_masked = '파기됨', phone_last4 = '0000',
         contact_time = null, purged_at = now(), updated_at = now()
   where customer_id = v_customer;
  delete from pii.customers where id = v_customer;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason)
  values (p_actor, 'pii.purge', 'lead', p_lead_id, p_reason);
end
$$;

create or replace function core.purge_lead_internal(p_lead_id uuid, p_actor uuid, p_reason text)
returns text
language plpgsql set search_path = '' as $$
declare
  v_customer uuid;
begin
  select l.customer_id into v_customer from core.leads l where l.id = p_lead_id for update;
  if v_customer is null then
    return 'none';
  end if;
  perform 1 from pii.customers c where c.id = v_customer for update;   -- 같은 고객의 동시 파기 직렬화
  if not exists (select 1 from core.leads l where l.customer_id = v_customer and l.id <> p_lead_id and l.purged_at is null) then
    perform core.purge_customer_internal(p_lead_id, p_actor, p_reason);
    return 'customer';
  end if;
  delete from pii.lead_applications a where a.lead_id = p_lead_id;
  delete from pii.lead_amendments a where a.lead_id = p_lead_id;
  delete from core.lead_notes n where n.lead_id = p_lead_id;   -- 0063: 상담 메모도 파기
  update core.recontact_schedule s set status = 'blocked', closed_at = now()
   where s.lead_id = p_lead_id and s.status = 'pending';
  update core.leads
     set customer_id = null, name_masked = '파기됨', phone_last4 = '0000',
         contact_time = null, purged_at = now(), updated_at = now()
   where id = p_lead_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason)
  values (p_actor, 'pii.purge_lead', 'lead', p_lead_id, p_reason);
  return 'lead';
end
$$;

create or replace function api.purge_lead(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_reason text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_status text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select l.status into v_status from core.leads l where l.id = p_lead_id and l.customer_id is not null;
  if v_status is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if core.legal_hold((select l.customer_id from core.leads l where l.id = p_lead_id)) and v_status = 'converted' then
    raise exception 'LEGAL_HOLD' using errcode = '55000';
  end if;
  return core.purge_lead_internal(p_lead_id, v_staff.user_id, p_reason);
end
$$;

create or replace function api.purge_customer(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_customer uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select l.customer_id into v_customer from core.leads l where l.id = p_lead_id and l.customer_id is not null;
  if v_customer is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if core.legal_hold(v_customer) then
    raise exception 'LEGAL_HOLD' using errcode = '55000';
  end if;
  perform core.purge_customer_internal(p_lead_id, v_staff.user_id, p_reason);
end
$$;

create or replace function core.purge_expired() returns int
language plpgsql set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select min(l.id::text)::uuid as lead_id from core.leads l join pii.customers c on c.id = l.customer_id
    where c.retention_until < now()
      and not core.legal_hold(c.id)
    group by c.id
    limit 1000
  loop
    perform core.purge_customer_internal(r.lead_id, null, 'retention_expired');
    n := n + 1;
  end loop;
  return n;
end
$$;

commit;
