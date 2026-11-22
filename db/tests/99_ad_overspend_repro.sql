-- PM 11/22 P1 광고비 초과 위험 — 0020 수정 검증(계정 합산 일 1만·누적 3만, 다른 캠페인 집행 중·중지 실패 경고 시 계정 전체 차단). 가상 데이터만, 실제 광고 API 없음.
\set ON_ERROR_STOP 1
\ir reset_ad_account.sql
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-os-a', 10000, 30000, now() + interval '3 days', '초과 위험 검증 A'$$), 'OS-DB1 캠페인 A 승인(일 1만·누적 3만)');
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-os-b', 10000, 30000, now() + interval '3 days', '초과 위험 검증 B'$$), 'OS-DB1b 캠페인 B 승인(캠페인 단위 승인은 그대로)');
-- OS2 수정: 같은 날 두 캠페인 합산
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-a', 10000, 'req-os-a-000000001'$$, 'decision'), 'ALLOW', 'OS-DB2 A 당일 1만 허용');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-b', 1, 'req-os-b-000000001'$$, 'reason'), 'ACCOUNT_DAILY_CAP_EXCEEDED', 'OS-DB2b B는 캠페인 한도 안이어도 계정 당일 합계 1만 초과로 차단(복수 캠페인 합산)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-a', 1, 'req-os-a-000000002'$$, 'reason'), 'DAILY_CAP_EXCEEDED', 'OS-DB3 캠페인 단위 일 한도도 그대로 동작');
reset role;
select test.expect_eq($$select coalesce(sum(amount_krw), 0)::text from core.ad_spend_ledger$$, '10000', 'OS-DB4 계정 원장 당일 합계 1만(2만이 되지 않음)');

-- 누적: 지난날 B 1만+1만, A 5천(원장 직접 기록) + 오늘 A 5천 = 계정 누적 3만 → 다음 1원은 차단
\ir reset_ad_account.sql
insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
select c, (select id from core.ad_budget_approvals where campaign_key = c and state = 'active'), (now() at time zone 'Asia/Seoul')::date - d, amt, k, '00000000-0000-4000-8000-000000000001'
from (values ('camp-os-b', 1, 10000, 'req-os-b-pre000001'), ('camp-os-b', 2, 10000, 'req-os-b-pre000002'), ('camp-os-a', 1, 5000, 'req-os-a-pre000001')) v(c, d, amt, k);
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-a', 5000, 'req-os-a-000000003'$$, 'decision'), 'ALLOW', 'OS-DB5 계정 누적 3만까지 허용');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-b', 1, 'req-os-b-000000002'$$, 'reason'), 'ACCOUNT_TOTAL_CAP_EXCEEDED', 'OS-DB5b 캠페인 누적은 2만이어도 계정 누적 3만 초과로 차단');
reset role;

-- 다른 캠페인이 집행 중(active)이면 차단: 계정당 동시 집행 1건
\ir reset_ad_account.sql
insert into core.ad_launches (campaign_key, request_key, amount_krw, state, external_id, created_by) values ('camp-os-a', 'req-os-launch-00001', 5000, 'active', 'ext-os-a', '00000000-0000-4000-8000-000000000001');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-b', 1000, 'req-os-b-000000003'$$, 'reason'), 'ACCOUNT_LAUNCH_OPEN', 'OS-DB6 다른 캠페인 launch가 열려 있으면 차단');
reset role;

-- 중지 실패 경고(다른 캠페인)가 열려 있으면 계정 전체 차단(fail-closed)
\ir reset_ad_account.sql
insert into core.ad_alerts (campaign_key, kind, detail, created_by) values ('camp-os-z', 'stop_failed', '{"paused": false}', '00000000-0000-4000-8000-000000000001');
set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-b', 1000, 'req-os-b-000000004'$$, 'reason'), 'STOP_PENDING', 'OS-DB7 다른 캠페인의 중지 실패 경고가 열려 있으면 계정 전체 지출 차단');
reset role;
\ir reset_ad_account.sql
