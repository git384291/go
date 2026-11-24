-- 0052_purge_scope.sql — 파기 범위 분리 (PM 11/25 B 승인)
-- 0051로 같은 연락처의 신청이 고객 1명에 묶이므로 파기를 두 절차로 나눈다.
-- 1) api.purge_lead: 신청 1건만 파기. 같은 고객의 다른 살아 있는 신청이 있으면 고객 정보·다른 신청은 보존하고
--    이 신청의 신청서(pii.lead_applications)·변경 요청(pii.lead_amendments)만 삭제, 리드는 가림 처리, 대기 재연락은 차단.
--    마지막 신청이면 고객 전체 파기와 같다(남길 이유가 없는 개인정보를 두지 않는다).
-- 2) api.purge_customer(기존): 고객 전체 파기(별도 절차). 대표만, 사유 5자 이상.
-- 3) 법정 보존: 계약 완료(converted) 신청이 있는 고객은 수동 파기 모두 'LEGAL_HOLD'로 거부(전자상거래법 계약 기록 5년 등 — 적용 여부 법률 확인 필요).
--    만료 자동 파기도 계약 완료 신청이 하나라도 있는 고객은 건너뛴다(기존엔 다른 신청 경로로 고객 전체가 지워질 수 있었음).
begin;

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

-- 고객 전체 파기(별도 절차): 계약 완료 신청이 있으면 거부
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

-- 보유기간 만료 파기(예약 작업 전용): 고객 단위로 1회, 계약 완료 신청이 있는 고객은 제외
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

commit;
