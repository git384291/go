-- 0069 설치·정산·환수 기록 (PM 11/27 CRM ⑤). 전환(converted)된 리드의 설치 일정 → 설치 완료 → 해지 시 환수 위험을 남긴다.
-- - core.lead_contracts: 리드당 1건. 통신사·설치 예정일·설치일·약정 개월·환수 기간(개월, 총판 정책에서 대표가 입력)·상태.
--   상태: scheduled(설치 예정) → installed(설치 완료) → terminated(해지) / scheduled → cancelled(설치 전 취소).
-- - core.settlements: 정산 원장(추가 전용). received(총판 지급 받음) / clawback(환수됨). 금액은 DB에만 둔다(공개 저장소에 수수료 없음).
-- - 환수 위험: 해지일 < 설치일 + 환수 기간이면 clawback_risk. 환수 금액이 기록되면 위험 해소(settled).
-- - 개인정보 없음: 이름·연락처는 저장하지 않고 리드의 가린 이름만 목록에 보인다. 자유 메모 없음.
-- - 대표(owner)만 쓰고 본다(금액 포함). 모든 쓰기는 감사 기록.
begin;

create table if not exists core.lead_contracts (
  lead_id             uuid primary key references core.leads(id),
  carrier             text not null check (carrier in ('KT', 'SKB', 'LGU', 'OTHER')),
  status              text not null default 'scheduled' check (status in ('scheduled', 'installed', 'cancelled', 'terminated')),
  install_scheduled_on date not null,
  installed_on        date,
  contract_months     int not null check (contract_months between 1 and 60),
  clawback_months     int not null check (clawback_months between 0 and 60),
  terminated_on       date,
  created_by          uuid not null references core.staff(user_id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status = 'scheduled' and installed_on is null and terminated_on is null)
      or (status = 'cancelled' and installed_on is null and terminated_on is null)
      or (status = 'installed' and installed_on is not null and terminated_on is null)
      or (status = 'terminated' and installed_on is not null and terminated_on is not null and terminated_on >= installed_on))
);
alter table core.lead_contracts enable row level security;
alter table core.lead_contracts force row level security;

create table if not exists core.settlements (
  id          bigint generated always as identity primary key,
  lead_id     uuid not null references core.lead_contracts(lead_id),
  kind        text not null check (kind in ('received', 'clawback')),
  amount_krw  int not null check (amount_krw between 1 and 10000000),
  occurred_on date not null,
  created_by  uuid not null references core.staff(user_id),
  created_at  timestamptz not null default now()
);
create index if not exists settlements_lead on core.settlements (lead_id, id);
alter table core.settlements enable row level security;
alter table core.settlements force row level security;

-- 계약: 삭제 금지, 상태는 정해진 순서로만, 식별·생성 값 고정
create or replace function core.lead_contracts_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CONTRACT_NO_DELETE' using errcode = '42501';
  end if;
  if new.lead_id is distinct from old.lead_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or not ((old.status = new.status and old.status = 'scheduled')
          or (old.status = 'scheduled' and new.status in ('installed', 'cancelled'))
          or (old.status = 'installed' and new.status = 'terminated')) then
    raise exception 'CONTRACT_TRANSITION' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists lead_contracts_guard on core.lead_contracts;
create trigger lead_contracts_guard before update or delete on core.lead_contracts for each row execute function core.lead_contracts_guard();
drop trigger if exists lead_contracts_no_truncate on core.lead_contracts;
create trigger lead_contracts_no_truncate before truncate on core.lead_contracts for each statement execute function core.block_truncate();

-- 정산 원장: 추가 전용(수정·삭제 금지)
create or replace function core.settlements_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'SETTLEMENT_APPEND_ONLY' using errcode = '42501';
end
$$;
drop trigger if exists settlements_guard on core.settlements;
create trigger settlements_guard before update or delete on core.settlements for each row execute function core.settlements_guard();
drop trigger if exists settlements_no_truncate on core.settlements;
create trigger settlements_no_truncate before truncate on core.settlements for each statement execute function core.block_truncate();

-- 설치 일정 등록·변경(설치 전만). 전환된 리드만.
create or replace function api.contract_schedule(p_actor uuid, p_session uuid, p_token text, p_lead uuid, p_carrier text,
                                                 p_install_on date, p_contract_months int, p_clawback_months int)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_cur core.lead_contracts;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_lead is null or p_carrier is null or p_carrier not in ('KT', 'SKB', 'LGU', 'OTHER')
     or p_install_on is null or p_install_on < v_today - 30 or p_install_on > v_today + 90
     or p_contract_months is null or p_contract_months not between 1 and 60
     or p_clawback_months is null or p_clawback_months not between 0 and p_contract_months then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from core.leads l where l.id = p_lead and l.purged_at is null and l.status = 'converted' for update;
  if not found then
    raise exception 'LEAD_NOT_CONVERTED' using errcode = '22023';   -- 없음·파기·미전환을 구분하지 않는다
  end if;
  select * into v_cur from core.lead_contracts c where c.lead_id = p_lead for update;
  if found and v_cur.status <> 'scheduled' then
    raise exception 'CONTRACT_TRANSITION' using errcode = '22023';
  end if;
  insert into core.lead_contracts (lead_id, carrier, install_scheduled_on, contract_months, clawback_months, created_by)
  values (p_lead, p_carrier, p_install_on, p_contract_months, p_clawback_months, v_staff.user_id)
  on conflict (lead_id) do update set carrier = excluded.carrier, install_scheduled_on = excluded.install_scheduled_on,
         contract_months = excluded.contract_months, clawback_months = excluded.clawback_months, updated_at = now();
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'contract.schedule', 'lead', p_lead,
          jsonb_build_object('carrier', p_carrier, 'install_on', p_install_on, 'contract_months', p_contract_months, 'clawback_months', p_clawback_months));
  return case when v_cur.lead_id is null then 'scheduled' else 'updated' end;
end
$$;

-- 상태 변경: installed(설치일) / cancelled / terminated(해지일). 결과: 'installed' | 'cancelled' | 'clawback_risk' | 'no_clawback'
create or replace function api.contract_status(p_actor uuid, p_session uuid, p_token text, p_lead uuid, p_status text, p_on date)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_cur core.lead_contracts;
  v_result text;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_lead is null or p_status is null or p_status not in ('installed', 'cancelled', 'terminated')
     or (p_status <> 'cancelled' and (p_on is null or p_on > v_today or p_on < v_today - 365))
     or (p_status = 'cancelled' and p_on is not null) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_cur from core.lead_contracts c where c.lead_id = p_lead for update;
  if not found
     or (p_status in ('installed', 'cancelled') and v_cur.status <> 'scheduled')
     or (p_status = 'terminated' and v_cur.status <> 'installed') then
    raise exception 'CONTRACT_TRANSITION' using errcode = '22023';
  end if;
  if p_status = 'terminated' and p_on < v_cur.installed_on then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update core.lead_contracts set status = p_status,
         installed_on = case when p_status = 'installed' then p_on else installed_on end,
         terminated_on = case when p_status = 'terminated' then p_on else terminated_on end,
         updated_at = now()
   where lead_id = p_lead;
  v_result := case
    when p_status <> 'terminated' then p_status
    when p_on < (v_cur.installed_on + make_interval(months => v_cur.clawback_months))::date then 'clawback_risk'
    else 'no_clawback' end;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'contract.' || p_status, 'lead', p_lead, jsonb_build_object('on', p_on, 'result', v_result));
  return v_result;
end
$$;

-- 정산 기록(추가 전용). received: 설치 완료·해지 뒤만. clawback: 해지 뒤만.
create or replace function api.settlement_record(p_actor uuid, p_session uuid, p_token text, p_lead uuid, p_kind text, p_amount_krw int, p_on date)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_cur core.lead_contracts;
  v_id bigint;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_lead is null or p_kind is null or p_kind not in ('received', 'clawback')
     or p_amount_krw is null or p_amount_krw not between 1 and 10000000
     or p_on is null or p_on > v_today or p_on < v_today - 730 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_cur from core.lead_contracts c where c.lead_id = p_lead for update;
  if not found
     or (p_kind = 'received' and v_cur.status not in ('installed', 'terminated'))
     or (p_kind = 'clawback' and v_cur.status <> 'terminated') then
    raise exception 'CONTRACT_TRANSITION' using errcode = '22023';
  end if;
  insert into core.settlements (lead_id, kind, amount_krw, occurred_on, created_by)
  values (p_lead, p_kind, p_amount_krw, p_on, v_staff.user_id) returning id into v_id;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'settlement.' || p_kind, 'lead', p_lead, jsonb_build_object('id', v_id, 'on', p_on));
  return v_id;
end
$$;

-- 목록(대표만). p_filter: all | scheduled | installed | terminated | cancelled | clawback_risk
create or replace function api.contract_list(p_actor uuid, p_session uuid, p_token text, p_filter text)
returns table (lead_id uuid, name_masked text, carrier text, status text, install_scheduled_on date, installed_on date,
               terminated_on date, contract_months int, clawback_until date, received_krw bigint, clawback_krw bigint, clawback_risk boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_filter is null or p_filter not in ('all', 'scheduled', 'installed', 'terminated', 'cancelled', 'clawback_risk') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select x.l_id, x.l_name, x.c_carrier, x.c_status, x.c_sched, x.c_inst, x.c_term, x.c_months, x.c_until, x.r_krw, x.cb_krw, x.risk from (
    select c.lead_id as l_id, l.name_masked as l_name, c.carrier as c_carrier, c.status as c_status, c.install_scheduled_on as c_sched,
           c.installed_on as c_inst, c.terminated_on as c_term, c.contract_months as c_months,
           case when c.installed_on is null then null else (c.installed_on + make_interval(months => c.clawback_months))::date end as c_until,
           coalesce(sum(s.amount_krw) filter (where s.kind = 'received'), 0)::bigint as r_krw,
           coalesce(sum(s.amount_krw) filter (where s.kind = 'clawback'), 0)::bigint as cb_krw,
           coalesce(c.status = 'terminated' and c.terminated_on < (c.installed_on + make_interval(months => c.clawback_months))::date
                    and not coalesce(bool_or(s.kind = 'clawback'), false), false) as risk
      from core.lead_contracts c
      join core.leads l on l.id = c.lead_id
      left join core.settlements s on s.lead_id = c.lead_id
     group by c.lead_id, l.name_masked
  ) x
  where p_filter = 'all' or (p_filter = 'clawback_risk' and x.risk) or x.c_status = p_filter
  order by coalesce(x.c_term, x.c_inst, x.c_sched) desc, x.l_id
  limit 500;
end
$$;

revoke all on function core.lead_contracts_guard(), core.settlements_guard() from public;

commit;
