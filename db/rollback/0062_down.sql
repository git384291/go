-- 0062 롤백: 신청 1건 파기 함수 제거, 고객 파기·만료 파기 0002 정의 복원
begin;
drop function if exists api.purge_lead(uuid, uuid, text, uuid, text);
drop function if exists core.purge_lead_internal(uuid, uuid, text);
create or replace function api.purge_customer(p_actor uuid, p_session uuid, p_token text, p_lead_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from core.leads l where l.id = p_lead_id and l.customer_id is not null) then
    raise exception 'FORBIDDEN' using errcode = '42501';
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
