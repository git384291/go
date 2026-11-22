-- 0020 광고비 계정 합산 한도·계정 단위 fail-closed (PM 11/22 P1, OS2·OS4 수정). 가상 DB 시험만, 실제 광고 API 없음.
-- - 지출 판정을 계정 전체로 직렬화하고, 캠페인 한도에 더해 계정 전체 일 10,000원·누적 30,000원(모든 캠페인 원장 합)을 넘으면 차단한다.
-- - 다른 캠페인의 launch가 requested·active·unknown이면 차단(계정당 동시 집행 1건). 중지 실패 경고가 하나라도 열려 있으면 계정 전체 차단.
-- - 함수 서명·권한은 0013과 같다(zz_grants 변경 없음). 롤백: db/rollback/0020_down.sql(0013 정의 복원).

create or replace function api.ad_spend_request(p_actor uuid, p_session uuid, p_token text, p_campaign text, p_amount int, p_request_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_staff  core.staff;
  v_app    core.ad_budget_approvals;
  v_today  date := (now() at time zone 'Asia/Seoul')::date;
  v_day    int;
  v_total  int;
  v_reason text;
  v_acc_day   int;
  v_acc_total int;
begin
  v_staff := security.assert_staff(p_actor, p_session, p_token, array['owner']);
  if p_campaign is null or p_campaign !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_amount is null or p_amount not between 1 and 10000
     or p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'INVALID_SPEND' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('adspend:account', 0));  -- 0020: 계정 전체 직렬화(복수 캠페인 합산 경합 방지)

  if exists (select 1 from core.ad_spend_ledger l where l.request_key = p_request_key) then
    v_reason := 'DUPLICATE_REQUEST';
  elsif exists (select 1 from core.ad_alerts al where al.state = 'open') then
    v_reason := 'STOP_PENDING';  -- 0020: 어느 캠페인이든 중지 실패 경고가 열려 있으면 계정 전체 지출 차단(fail-closed)
  elsif exists (select 1 from core.ad_launches l where l.campaign_key <> p_campaign and l.state in ('requested', 'active', 'unknown')) then
    v_reason := 'ACCOUNT_LAUNCH_OPEN';  -- 0020: 다른 캠페인이 집행 중·불명이면 차단(계정당 동시 집행 1건)
  else
    select * into v_app from core.ad_budget_approvals a where a.campaign_key = p_campaign and a.state = 'active';
    if not found then
      v_reason := 'NO_APPROVAL';
    elsif v_app.valid_from > now() or v_app.valid_until <= now() then
      v_reason := 'APPROVAL_EXPIRED';
    else
      select coalesce(sum(l.amount_krw), 0) into v_day from core.ad_spend_ledger l where l.campaign_key = p_campaign and l.spend_date = v_today;
      select coalesce(sum(l.amount_krw), 0) into v_total from core.ad_spend_ledger l where l.approval_id = v_app.id;
      if v_day + p_amount > v_app.daily_cap_krw then
        v_reason := 'DAILY_CAP_EXCEEDED';
      elsif v_total + p_amount > v_app.total_cap_krw then
        v_reason := 'TOTAL_CAP_EXCEEDED';
      else
        -- 0020: 계정 전체 합산(모든 캠페인) — 일 10,000원·누적 30,000원
        select coalesce(sum(l.amount_krw), 0) into v_acc_day from core.ad_spend_ledger l where l.spend_date = v_today;
        select coalesce(sum(l.amount_krw), 0) into v_acc_total from core.ad_spend_ledger l;
        if v_acc_day + p_amount > 10000 then
          v_reason := 'ACCOUNT_DAILY_CAP_EXCEEDED';
        elsif v_acc_total + p_amount > 30000 then
          v_reason := 'ACCOUNT_TOTAL_CAP_EXCEEDED';
        end if;
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
    values (v_staff.user_id, 'ad.spend_blocked', 'ad_budget_approval', v_app.id, v_reason,
            jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount));
    return jsonb_build_object('decision', 'BLOCK', 'reason', v_reason);
  end if;

  insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
  values (p_campaign, v_app.id, v_today, p_amount, p_request_key, v_staff.user_id);
  insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
  values (v_staff.user_id, 'ad.spend_allow', 'ad_budget_approval', v_app.id, null,
          jsonb_build_object('campaign', p_campaign, 'amount_krw', p_amount, 'spent_today', v_day + p_amount, 'spent_total', v_total + p_amount));
  return jsonb_build_object('decision', 'ALLOW', 'reason', null,
    'spent_today', v_day + p_amount, 'daily_cap_krw', v_app.daily_cap_krw,
    'spent_total', v_total + p_amount, 'total_cap_krw', v_app.total_cap_krw,
    'warn', (v_day + p_amount) >= v_app.daily_cap_krw * 0.8 or (v_total + p_amount) >= v_app.total_cap_krw * 0.8);
end
$$;
