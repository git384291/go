-- 0050 날짜별 재연락 일정·수신 거부 (PM 11/25 ③). 가상 데이터 검증 전용 — 실제 발신 기능은 이 파일에 없다.
-- - core.recontact_schedule: 리드별 재연락 예정일(KST 날짜)·채널. 같은 리드는 같은 날 대기 1건만(중복 연락 방지), 리드당 대기 최대 3건.
-- - 연락 가능 판정(core.recontact_allowed): 채널별 마지막 수신 이벤트가 opt_out이면 차단, opt_in·reconfirm이면 허용.
--   이벤트가 없으면 전화 채널만 대표 직접 연락 동의(0023)가 있을 때 허용, 그 외는 NO_CONSENT.
-- - api.recontact_schedule / due / close / sweep: 대표(owner)만. 목록은 가린 이름·관심 상품만, 연락처 원문은 기존 reveal_contact로만.
-- - api.marketing_opt_out: 공개 요청(서버 서명 필수). 연락처 존재 여부를 알려주지 않도록 항상 'recorded'를 돌려준다.
begin;

create table if not exists core.recontact_schedule (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references core.leads(id),
  due_on     date not null,
  channel    text not null check (channel in ('phone', 'sms', 'alimtalk')),
  status     text not null default 'pending' check (status in ('pending', 'done', 'cancelled', 'blocked')),
  created_by uuid not null references core.staff(user_id),
  created_at timestamptz not null default now(),
  closed_by  uuid references core.staff(user_id),
  closed_at  timestamptz,
  check ((status = 'pending' and closed_at is null) or (status <> 'pending' and closed_at is not null)),
  check (status in ('pending', 'blocked') or closed_by is not null)
);
create unique index if not exists recontact_one_pending_per_day on core.recontact_schedule (lead_id, due_on) where status = 'pending';
create index if not exists recontact_pending_due on core.recontact_schedule (due_on, id) where status = 'pending';
alter table core.recontact_schedule enable row level security;
alter table core.recontact_schedule force row level security;

create or replace function core.recontact_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'RECONTACT_APPEND_ONLY' using errcode = '42501';
  end if;
  if old.status <> 'pending' or new.status = 'pending'
     or new.id is distinct from old.id or new.lead_id is distinct from old.lead_id
     or new.due_on is distinct from old.due_on or new.channel is distinct from old.channel
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'RECONTACT_APPEND_ONLY' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists recontact_guard on core.recontact_schedule;
create trigger recontact_guard before update or delete on core.recontact_schedule for each row execute function core.recontact_guard();
drop trigger if exists recontact_no_truncate on core.recontact_schedule;
create trigger recontact_no_truncate before truncate on core.recontact_schedule for each statement execute function core.block_truncate();

-- 연락 가능 판정. 'OK' | 'OPTED_OUT' | 'NO_CONSENT'
create or replace function core.recontact_allowed(p_customer uuid, p_channel text)
returns text language sql stable set search_path = '' as $$
  select case
    when m.event = 'opt_out' then 'OPTED_OUT'
    when m.event in ('opt_in', 'reconfirm') then 'OK'
    when p_channel = 'phone' and exists (
      select 1 from core.lead_followups f join core.leads l on l.id = f.lead_id
      where l.customer_id = p_customer and f.event = 'requested') then 'OK'
    else 'NO_CONSENT'
  end
  from (select 1) d
  left join lateral (
    select c.event from pii.marketing_consents c
    where c.customer_id = p_customer and c.channel = p_channel
    order by c.created_at desc limit 1) m on true
$$;

create or replace function api.recontact_schedule(p_actor uuid, p_session uuid, p_token text, p_lead uuid, p_due_on date, p_channel text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_customer uuid;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_ok text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);   -- MVP: 대표만
  if p_lead is null or p_due_on is null or p_channel is null or p_channel not in ('phone', 'sms', 'alimtalk')
     or p_due_on < v_today or p_due_on > v_today + 90 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('recontact:' || p_lead::text, 0));
  select l.customer_id into v_customer from core.leads l where l.id = p_lead and l.purged_at is null;
  if v_customer is null then
    raise exception 'LEAD_NOT_FOUND' using errcode = '22023';
  end if;
  v_ok := core.recontact_allowed(v_customer, p_channel);
  if v_ok <> 'OK' then
    raise exception '%', v_ok using errcode = '22023';
  end if;
  if exists (select 1 from core.recontact_schedule s where s.lead_id = p_lead and s.due_on = p_due_on and s.status = 'pending') then
    return 'exists';
  end if;
  if (select count(*) from core.recontact_schedule s where s.lead_id = p_lead and s.status = 'pending') >= 3 then
    raise exception 'TOO_MANY_PENDING' using errcode = '22023';
  end if;
  insert into core.recontact_schedule (lead_id, due_on, channel, created_by) values (p_lead, p_due_on, p_channel, v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'recontact.schedule', 'lead', p_lead, jsonb_build_object('due_on', p_due_on, 'channel', p_channel));
  return 'scheduled';
end
$$;

-- 오늘(KST) 이하 대기 건. 지금도 연락 가능한 건만 보이고, overdue = 예정일이 지난 미처리 건.
create or replace function api.recontact_due(p_actor uuid, p_session uuid, p_token text)
returns table (schedule_id bigint, lead_id uuid, name_masked text, interest text, channel text, due_on date, overdue boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner']);
  return query
  select s.id, l.id, l.name_masked, l.interest, s.channel, s.due_on, s.due_on < v_today
  from core.recontact_schedule s
  join core.leads l on l.id = s.lead_id
  where s.status = 'pending' and s.due_on <= v_today and l.purged_at is null and l.customer_id is not null
    and core.recontact_allowed(l.customer_id, s.channel) = 'OK'
  order by s.due_on asc, s.id asc
  limit 200;
end
$$;

create or replace function api.recontact_close(p_actor uuid, p_session uuid, p_token text, p_id bigint, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_row core.recontact_schedule;
  v_customer uuid;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_status is null or p_status not in ('done', 'cancelled') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_row from core.recontact_schedule s where s.id = p_id for update;
  if not found or v_row.status <> 'pending' then
    raise exception 'NOT_PENDING' using errcode = '22023';
  end if;
  if p_status = 'done' then
    select l.customer_id into v_customer from core.leads l where l.id = v_row.lead_id;
    if v_customer is null or core.recontact_allowed(v_customer, v_row.channel) <> 'OK' then
      raise exception 'OPTED_OUT' using errcode = '22023';
    end if;
  end if;
  update core.recontact_schedule set status = p_status, closed_by = v_staff.user_id, closed_at = now() where id = p_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'recontact.' || p_status, 'lead', v_row.lead_id, jsonb_build_object('schedule_id', p_id));
end
$$;

-- 그 사이 수신 거부·동의 철회된 대기 건을 차단 처리한다. 처리 건수 반환.
create or replace function api.recontact_sweep(p_actor uuid, p_session uuid, p_token text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_n int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  with blocked as (
    update core.recontact_schedule s set status = 'blocked', closed_by = v_staff.user_id, closed_at = now()
    from core.leads l
    where s.status = 'pending' and l.id = s.lead_id
      and (l.customer_id is null or l.purged_at is not null or core.recontact_allowed(l.customer_id, s.channel) <> 'OK')
    returning s.id)
  select count(*) into v_n from blocked;
  insert into core.audit_logs (actor_id, action, target_type, detail)
  values (v_staff.user_id, 'recontact.sweep', 'recontact', jsonb_build_object('blocked', v_n));
  return v_n;
end
$$;

-- 수신 거부(공개). 같은 연락처의 모든 고객 행에 채널별 opt_out을 추가하고 대기 중 재연락을 차단한다.
-- 연락처가 있든 없든 같은 응답('recorded')을 돌려준다(가입 여부 노출 방지).
create or replace function api.marketing_opt_out(p_token text, p_phone_hmac text, p_channel text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c record;
  ch text;
  v_n int := 0;
begin
  if not security.verify_token('lead', p_token, array['optout', p_phone_hmac, p_channel]) then
    raise exception 'INVALID_SIGNATURE' using errcode = '42501';
  end if;
  if p_phone_hmac is null or p_phone_hmac !~ '^[0-9a-f]{64}$' or p_channel is null
     or p_channel not in ('all', 'phone', 'sms', 'alimtalk') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead:' || p_phone_hmac, 0));
  for c in select id from pii.customers where phone_hmac = p_phone_hmac loop
    foreach ch in array case when p_channel = 'all' then array['phone', 'sms', 'alimtalk'] else array[p_channel] end loop
      if coalesce((select m.event from pii.marketing_consents m where m.customer_id = c.id and m.channel = ch
                   order by m.created_at desc limit 1), '') <> 'opt_out' then
        insert into pii.marketing_consents (customer_id, event, channel, created_at)
        values (c.id, 'opt_out', ch, clock_timestamp());
        v_n := v_n + 1;
      end if;
      update core.recontact_schedule s set status = 'blocked', closed_at = now()
      from core.leads l
      where s.status = 'pending' and s.channel = ch and l.id = s.lead_id and l.customer_id = c.id;
    end loop;
  end loop;
  if v_n > 0 then
    insert into core.audit_logs (action, target_type, detail)
    values ('marketing.opt_out', 'customer', jsonb_build_object('channel', p_channel, 'events', v_n));
  end if;
  return 'recorded';
end
$$;

commit;
