-- 0053 고객별 상담·통화·접수 이력 통합 (PM 11/25 ④)
-- - 고객 = 같은 연락처 HMAC의 리드 묶음. 기준 리드를 볼 수 있어야 하고, 묶음 안에서도 볼 수 있는 리드의 기록만 보여 준다
--   (대표·검토자: 전부, 상담원: 자기 담당 리드만 → 담당 아닌 리드 기록으로 우회 열람 불가).
-- - 미연결 통화는 고객 이력에 넣지 않는다(오연결 방지). 연결은 0050 api.call_link(대표)로만.
-- - 개인정보: 이름·전화 원문·녹취 위치·변환 원문·메모 본문·신청서 요약(해시 포함)은 돌려주지 않는다. 가린 이름·뒤 4자리·가린 요약·건수만.
-- - 저장 데이터가 없는 채널(AI 상담 대화 원문, 문자 발송)은 이력에 없다 — 해당 저장소가 생기면 이 함수에 추가.
-- - 조회는 감사 기록. 기간 필수(고객 366일, 날짜별 31일), 최대 500건.
begin;

create or replace function core.timeline_leads(p_staff core.staff, p_lead uuid)
returns table (lead_id uuid)
language sql stable set search_path = '' as $$
  with base as (
    select l.id, c.phone_hmac from core.leads l left join pii.customers c on c.id = l.customer_id
     where l.id = p_lead
       and (p_staff.role in ('owner', 'reviewer') or l.assigned_to = p_staff.user_id)
  )
  select b.id from base b
  union
  select l.id from base b join pii.customers c on c.phone_hmac = b.phone_hmac join core.leads l on l.customer_id = c.id
   where b.phone_hmac is not null and l.purged_at is null
     and (p_staff.role in ('owner', 'reviewer') or l.assigned_to = p_staff.user_id)
$$;

create or replace function core.timeline_events(p_leads uuid[], p_from timestamptz, p_to timestamptz)
returns table (at timestamptz, kind text, lead_id uuid, ref text, detail jsonb)
language sql stable set search_path = '' as $$
  select l.created_at, 'lead_created', l.id, l.id::text,
         jsonb_build_object('interest', l.interest, 'status', l.status, 'name_masked', l.name_masked, 'phone_last4', l.phone_last4, 'utm_source', l.utm_source)
    from core.leads l where l.id = any (p_leads) and l.created_at >= p_from and l.created_at < p_to
  union all
  select h.at, 'status_change', h.lead_id, h.id::text, jsonb_build_object('from', h.from_status, 'to', h.to_status, 'reason', h.reason)
    from core.lead_status_history h where h.lead_id = any (p_leads) and h.at >= p_from and h.at < p_to
  union all
  select n.created_at, 'note', n.lead_id, n.id::text, jsonb_build_object('length', length(n.body), 'author', n.author_id)
    from core.lead_notes n where n.lead_id = any (p_leads) and n.created_at >= p_from and n.created_at < p_to
  union all
  select f.created_at, 'followup_' || f.event, f.lead_id, f.id::text, '{}'::jsonb
    from core.lead_followups f where f.lead_id = any (p_leads) and f.created_at >= p_from and f.created_at < p_to
  union all
  select a.created_at, 'application', a.lead_id, a.id::text,
         jsonb_build_object('answered', a.summary->'answered',
                            'missing', case when jsonb_typeof(a.summary->'missing') = 'array' then jsonb_array_length(a.summary->'missing') else 0 end)
    from pii.lead_applications a where a.lead_id = any (p_leads) and a.created_at >= p_from and a.created_at < p_to
  union all
  select m.created_at, 'amendment', m.lead_id, m.id::text, '{}'::jsonb
    from pii.lead_amendments m where m.lead_id = any (p_leads) and m.created_at >= p_from and m.created_at < p_to
  union all
  select c.started_at, 'call', c.lead_id, c.id::text,
         jsonb_build_object('direction', c.direction, 'duration_sec', c.duration_sec, 'recording', c.recording_state,
                            'link', c.link_method, 'ambiguous', c.ambiguous,
                            'transcribed', exists (select 1 from pii.call_transcripts t where t.call_id = c.id),
                            'summary', (select jsonb_build_object('version', s.version, 'source', s.source, 'product', s.product,
                                                                  'outcome', s.outcome, 'callback_at', s.callback_at, 'text', s.summary_masked)
                                          from core.call_summaries s where s.call_id = c.id order by s.version desc limit 1))
    from core.calls c where c.lead_id = any (p_leads) and c.started_at >= p_from and c.started_at < p_to
  union all
  -- 재연락 일정: 통화의 최신 요약 판 기준
  select s.callback_at, 'callback_due', c.lead_id, c.id::text, jsonb_build_object('version', s.version, 'source', s.source)
    from core.calls c
    join lateral (select x.* from core.call_summaries x where x.call_id = c.id order by x.version desc limit 1) s on true
   where c.lead_id = any (p_leads) and s.callback_at is not null and s.callback_at >= p_from and s.callback_at < p_to
     and c.recording_state <> 'deleted'
$$;

create or replace function api.customer_timeline(p_actor uuid, p_session uuid, p_token text, p_lead uuid, p_from date, p_to date)
returns table (at timestamptz, kind text, lead_id uuid, ref text, detail jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_leads uuid[];
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor', 'reviewer']);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'INVALID_RANGE' using errcode = '22023';
  end if;
  select array_agg(t.lead_id) into v_leads from core.timeline_leads(v_staff, p_lead) t;
  if v_leads is null then
    raise exception 'FORBIDDEN' using errcode = '42501';   -- 없음·권한 없음을 구분하지 않는다
  end if;
  insert into core.audit_logs (actor_id, action, target_type, target_id, detail)
  values (v_staff.user_id, 'timeline.view', 'lead', p_lead, jsonb_build_object('leads', cardinality(v_leads), 'from', p_from, 'to', p_to));
  return query select e.* from core.timeline_events(v_leads,
                                (p_from::timestamp at time zone 'Asia/Seoul'), ((p_to + 1)::timestamp at time zone 'Asia/Seoul')) e
                order by e.at desc, e.kind, e.ref limit 500;
end
$$;

-- 날짜별 조회(KST). 볼 수 있는 리드 전체. 미연결 통화는 대표만 'call_unmatched'로 본다.
create or replace function api.timeline_by_date(p_actor uuid, p_session uuid, p_token text, p_from date, p_to date)
returns table (at timestamptz, kind text, lead_id uuid, ref text, detail jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_staff core.staff;
  v_from  timestamptz;
  v_to    timestamptz;
  v_leads uuid[];
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner', 'counselor', 'reviewer']);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 31 then
    raise exception 'INVALID_RANGE' using errcode = '22023';
  end if;
  v_from := p_from::timestamp at time zone 'Asia/Seoul';
  v_to   := (p_to + 1)::timestamp at time zone 'Asia/Seoul';
  -- 기간 안에 기록이 있는 볼 수 있는 리드만 모은다
  select array_agg(distinct l.id) into v_leads
    from core.leads l
   where (v_staff.role in ('owner', 'reviewer') or l.assigned_to = v_staff.user_id)
     and (   (l.created_at >= v_from and l.created_at < v_to)
          or exists (select 1 from core.lead_status_history h where h.lead_id = l.id and h.at >= v_from and h.at < v_to)
          or exists (select 1 from core.lead_notes n where n.lead_id = l.id and n.created_at >= v_from and n.created_at < v_to)
          or exists (select 1 from core.lead_followups f where f.lead_id = l.id and f.created_at >= v_from and f.created_at < v_to)
          or exists (select 1 from pii.lead_applications a where a.lead_id = l.id and a.created_at >= v_from and a.created_at < v_to)
          or exists (select 1 from pii.lead_amendments m where m.lead_id = l.id and m.created_at >= v_from and m.created_at < v_to)
          or exists (select 1 from core.calls c where c.lead_id = l.id and c.started_at >= v_from and c.started_at < v_to)
          or exists (select 1 from core.calls c join core.call_summaries s on s.call_id = c.id
                      where c.lead_id = l.id and s.callback_at >= v_from and s.callback_at < v_to));
  insert into core.audit_logs (actor_id, action, target_type, detail)
  values (v_staff.user_id, 'timeline.by_date', 'lead', jsonb_build_object('from', p_from, 'to', p_to, 'leads', coalesce(cardinality(v_leads), 0)));
  return query
    select e.* from (
      select * from core.timeline_events(coalesce(v_leads, '{}'::uuid[]), v_from, v_to)
      union all
      select c.started_at, 'call_unmatched', null::uuid, c.id::text,
             jsonb_build_object('direction', c.direction, 'duration_sec', c.duration_sec, 'recording', c.recording_state)
        from core.calls c
       where v_staff.role = 'owner' and c.lead_id is null and c.started_at >= v_from and c.started_at < v_to
    ) e
    order by e.at desc, e.kind, e.ref limit 500;
end
$$;

revoke all on function core.timeline_leads(core.staff, uuid), core.timeline_events(uuid[], timestamptz, timestamptz) from public;

commit;
