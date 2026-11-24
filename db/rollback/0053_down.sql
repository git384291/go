-- 0053 롤백: 메모 파기·5년 보존 판정 제거, 0002·0052 정의 복원
begin;
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
  if v_status = 'converted' then
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
  if exists (select 1 from core.leads l where l.customer_id = v_customer and l.status = 'converted') then
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
      and not exists (select 1 from core.leads k where k.customer_id = c.id and k.status = 'converted')
    group by c.id
    limit 1000
  loop
    perform core.purge_customer_internal(r.lead_id, null, 'retention_expired');
    n := n + 1;
  end loop;
  return n;
end
$$;
drop function if exists core.legal_hold(uuid);
commit;
