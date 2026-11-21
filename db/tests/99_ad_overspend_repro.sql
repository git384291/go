-- PM 11/22 P1 재현(현재 동작 기록, 수정 아님): 예산 승인·원장은 캠페인 단위라 계정 전체 합산 한도가 없다. 가상 데이터만, 실제 광고 API 없음.
\set ON_ERROR_STOP 1
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-os-a', 10000, 30000, now() + interval '3 days', '초과 위험 재현 A'$$), 'OS-DB1 캠페인 A 승인(일 1만·누적 3만)');
select test.expect_ok(test.adcall('owner', 'ad_budget_approve', $$'camp-os-b', 10000, 30000, now() + interval '3 days', '초과 위험 재현 B'$$), 'OS-DB1b 캠페인 B도 같은 한도로 따로 승인됨(계정 합산 검사 없음)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-a', 10000, 'req-os-a-000000001'$$, 'decision'), 'ALLOW', 'OS-DB2 A 당일 1만 허용');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-b', 10000, 'req-os-b-000000001'$$, 'decision'), 'ALLOW', 'OS-DB2b B도 같은 날 1만 허용 → 계정 당일 승인 합계 2만(일 1만 한도의 2배, Google 2배 지출 시 최대 4만)');
select test.expect_eq(test.lx('owner', 'ad_spend_request', $$'camp-os-a', 1, 'req-os-a-000000002'$$, 'reason'), 'DAILY_CAP_EXCEEDED', 'OS-DB3 캠페인 단위 일 한도는 동작(A 추가 1원 차단)');
reset role;
select test.expect_eq($$select coalesce(sum(amount_krw), 0)::text from core.ad_spend_ledger where campaign_key like 'camp-os-%'$$, '20000', 'OS-DB4 원장 합계(같은 날 두 캠페인) 2만(계정 단위 한도 없음 재현)');
