-- 광고 사전검증(PM 11/24 10. 예약 집행): 승인 시작 시각(valid_from) 전에는 지출 판정이 차단되는지. 가상 데이터만, 실제 광고 API 없음.
-- 지금 앱 경로(adRun → api.ad_spend_request_window)와 예전 경로(api.ad_spend_request) 둘 다 확인한다.
\set ON_ERROR_STOP 1
\ir reset_ad_account.sql
set role app_ad_monitor;
select api.ad_monitor_record(true, '{"checked": 0}'::jsonb);  -- 정기 감시 정상(다른 사유로 막히지 않게)
reset role;

-- 시작 시각이 1시간 뒤인 승인(예약). 승인 API는 시작을 항상 '지금'으로 두므로, 미래 시작은 DB에 직접 넣어 경계를 시험한다
insert into core.ad_budget_approvals (campaign_key, daily_cap_krw, total_cap_krw, valid_from, valid_until, approved_by, reason)
values ('camp-sched', 5000, 5000, now() + interval '1 hour', now() + interval '50 hours', '00000000-0000-4000-8000-000000000001', '예약 시작 시험(가상)');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-sched', 1000, 'req-sched-00000001'$$, 'reason'), 'APPROVAL_EXPIRED', 'SC1 시작 시각 전(집행 경로) → 차단');
select test.expect_eq($$select test.addecide('owner', 'camp-sched', 1000, 'req-sched-00000002')$$, 'BLOCK:APPROVAL_EXPIRED', 'SC1b 시작 시각 전(예전 경로) → 차단');
reset role;
select test.expect_eq($$select count(*)::text from core.ad_spend_ledger where campaign_key = 'camp-sched'$$, '0', 'SC1c 차단된 예약은 지출 원장 0건');

-- 대조군: 같은 조건에서 시작 시각이 이미 지난 승인은 허용(시험이 '항상 차단'으로 통과하는 것이 아님을 확인)
insert into core.ad_budget_approvals (campaign_key, daily_cap_krw, total_cap_krw, valid_from, valid_until, approved_by, reason)
values ('camp-sched-on', 5000, 5000, now() - interval '1 minute', now() + interval '50 hours', '00000000-0000-4000-8000-000000000001', '예약 시작 대조군(가상)');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-sched-on', 1000, 'req-sched-on-0000001'$$, 'decision'), 'ALLOW', 'SC2 대조군: 시작 시각 지난 승인은 허용');
select test.expect_eq(test.lx('owner', 'ad_spend_request_window', $$'camp-sched-on', 1000, 'req-sched-on-0000001'$$, 'decision'), 'BLOCK', 'SC2b 같은 요청 키 재실행은 차단(1회만)');
reset role;
select test.expect_eq($$select count(*)::text from core.ad_spend_ledger where campaign_key = 'camp-sched-on'$$, '1', 'SC2c 허용은 원장 1건(재실행분 없음)');
\ir reset_ad_account.sql
