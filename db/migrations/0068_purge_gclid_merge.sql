-- 0068: 통합 보정 — CRM 파기 함수(0062·0063)가 광고 클릭 식별값(gclid, 0027) 파기를 덮어써 사라진 것을 복구한다.
-- 원인: 0027(광고·상담 PR #29)과 0062·0063(CRM PR #21)이 같은 파기 함수 3개를 각자 새로 정의했다. 번호는 안 겹치지만 나중 파일이 앞 파일의 gclid 삭제를 지웠다.
-- 내용: 0063 본문 그대로 + gclid 삭제 줄만 추가(고객 파기·리드 단독 파기·90일 만료). 권한·소유자는 create or replace라 그대로 유지된다.
-- 이 파일은 통합 브랜치에서만 의미가 있다(0027이 없는 브랜치에서는 pii.lead_clicks가 없어 실행 불가).
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
  -- 0068: 광고 클릭 식별값(gclid, 0027)도 리드 연결을 끊기 전에 함께 파기
  delete from pii.lead_clicks where lead_id in (select l.id from core.leads l where l.customer_id = v_customer);
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
  delete from pii.lead_clicks where lead_id = p_lead_id;   -- 0068: gclid도 파기(0027)
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

create or replace function core.purge_expired() returns int
language plpgsql set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  delete from pii.lead_clicks where captured_at < now() - interval '90 days';  -- 0068: 수집 후 90일 지난 gclid 삭제(0027)
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
