-- 광고 중지 실패 경고(0013)와 관리자 AI 월 한도. 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1
create function test.alertid(p_camp text) returns text language sql security definer set search_path = pg_catalog as $$
  select id::text from core.ad_alerts where campaign_key = p_camp and state = 'open' $$;
create function test.aidec(p_camp text, p_amount int, p_key text) returns text language sql security definer set search_path = test, pg_catalog as $$ select test.addecide('owner', p_camp, p_amount, p_key) $$;
create function test.adcall0(p_who text, p_fn text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'editor' then '00000000-0000-4000-8000-000000000006'
                       when 'reviewer' then '00000000-0000-4000-8000-000000000005' else '00000000-0000-4000-8000-000000000002' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'editor' then '10000000-0000-4000-8000-000000000008'
                       when 'reviewer' then '10000000-0000-4000-8000-000000000005' else '10000000-0000-4000-8000-000000000002' end;
begin
  return format('select * from api.%s(%L, %L, %L)', p_fn, a, s, test.staff_token(a, s));
end $$;

set role app_staff;
select test.expect_ok(test.adapprove('owner', 'camp-w', 5000, 20000), 'W0 승인');
select test.expect_ok(test.adcall('owner', 'ad_alert_open', $$'camp-w', '{"revoked": false, "paused": false}'::jsonb$$), 'W1 대표가 중지 실패 경고 열기');
select test.expect_error(test.adcall('editor', 'ad_alert_open', $$'camp-w', '{}'::jsonb$$), '42501', 'W1b 편집자 경고 열기 불가');
select test.expect_error(test.adcall('reviewer', 'ad_alert_open', $$'camp-w', '{}'::jsonb$$), '42501', 'W1c 검토자 경고 열기 불가');
select test.expect_error(test.adcall('counselor', 'ad_alert_open', $$'camp-w', '{}'::jsonb$$), '42501', 'W1d 상담원 경고 열기 불가');
select test.expect_error(test.adcall('owner', 'ad_alert_open', $$'Bad Key', '{}'::jsonb$$), '22023', 'W1e 캠페인 키 형식 거부');
select test.expect_error(test.adcall('owner', 'ad_alert_open', $$'camp-w', '[1]'::jsonb$$), '22023', 'W1f 상세가 객체가 아니면 거부');
reset role;
select test.expect_eq($$select count(*)::text from core.ad_alerts where campaign_key = 'camp-w' and state = 'open'$$, '1', 'W2 열린 경고 1건');
set role app_staff;
select test.expect_ok(test.adcall('owner', 'ad_alert_open', $$'camp-w', '{"revoked": false, "paused": false}'::jsonb$$), 'W2b 같은 캠페인 재호출은 멱등');
reset role;
select test.expect_eq($$select count(*)::text from core.ad_alerts where campaign_key = 'camp-w'$$, '1', 'W2c 중복 경고 없음');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.stop_failed' and detail->>'campaign' = 'camp-w'$$, '1', 'W2d 경고 감사 기록 1건');
-- W3 경고가 열려 있으면 지출·새 승인 모두 차단(활성 승인이 남아 있어도)
set role app_staff;
select test.expect_eq($$select test.aidec('camp-w', 100, 'req-w-0000000000001')$$, 'BLOCK:STOP_PENDING', 'W3 경고 열림 → 지출 차단(STOP_PENDING)');
select test.expect_error_msg(test.adapprove('owner', 'camp-w', 5000, 20000), '22023', 'ALERT_OPEN', 'W3b 경고 열림 → 새 승인 불가');
select test.expect_eq($$select test.aidec('camp-other', 100, 'req-w-0000000000002')$$, 'BLOCK:NO_APPROVAL', 'W3c 다른 캠페인은 영향 없음(원래 규칙)');
-- W4 목록
select test.expect_ok(test.adcall('reviewer', 'ad_alert_list', '50'), 'W4 검토자 경고 목록 조회');
select test.expect_error(test.adcall('counselor', 'ad_alert_list', '50'), '42501', 'W4b 상담원 조회 불가');
select test.expect_error(test.adcall('owner', 'ad_alert_list', '0'), '22023', 'W4c 범위 밖 limit 거부');
-- W5 해결: 대표만, 사유 필수, 한 번만
select test.expect_error(test.adcall('reviewer', 'ad_alert_resolve', $$test.alertid('camp-w')::uuid, '확인 완료'$$), '42501', 'W5 검토자 해결 불가');
select test.expect_error(test.adcall('owner', 'ad_alert_resolve', $$test.alertid('camp-w')::uuid, ' '$$), '22023', 'W5b 사유 필수');
select test.expect_ok(test.adcall('owner', 'ad_alert_resolve', $$test.alertid('camp-w')::uuid, '플랫폼에서 수동 중지 확인'$$), 'W5c 대표 해결');
select test.expect_eq($$select test.aidec('camp-w', 100, 'req-w-0000000000003')$$, 'ALLOW:', 'W6 해결 뒤에는 기존 승인 범위에서 다시 지출 판정');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.alert_resolve'$$, '1', 'W6b 해결 감사 기록');
select test.expect_error($$update core.ad_alerts set detail = '{}'::jsonb$$, '42501', 'W7 경고 내용 수정 불가');
select test.expect_error($$update core.ad_alerts set state = 'open' where state = 'resolved'$$, '42501', 'W7b 해결된 경고 되돌리기 불가');
select test.expect_error($$delete from core.ad_alerts$$, '42501', 'W7c 경고 삭제 불가');
set role app_staff;
select test.expect_error_msg(test.adcall('owner', 'ad_alert_resolve', $$'00000000-0000-4000-8000-0000000000f0'::uuid, '없는 경고'$$), '22023', 'NO_OPEN_ALERT', 'W7d 열린 경고가 없으면 해결 불가');
select test.expect_ok(test.adapprove('owner', 'camp-w', 5000, 20000), 'W8 해결 뒤에는 새 승인 가능');
select test.expect_error($$select * from core.ad_alerts$$, '42501', 'W9 앱 역할은 경고 테이블 직접 조회 불가');
reset role;

-- AI 월 한도 설정
update core.ai_budget_config set monthly_limit_krw = 0 where singleton;
set role app_staff;
select test.expect_ok(test.adcall0('owner', 'ai_budget_limit_get'), 'L1 대표 조회');
select test.expect_ok(test.adcall0('reviewer', 'ai_budget_limit_get'), 'L1b 검토자 조회');
select test.expect_error(test.adcall0('editor', 'ai_budget_limit_get'), '42501', 'L1c 편집자 조회 불가');
select test.expect_error(test.adcall('counselor', 'ai_budget_limit_set', $$100, '시험'$$), '42501', 'L2 상담원 설정 불가');
select test.expect_error(test.adcall('reviewer', 'ai_budget_limit_set', $$100, '시험'$$), '42501', 'L2b 검토자 설정 불가');
select test.expect_error(test.adcall('editor', 'ai_budget_limit_set', $$100, '시험'$$), '42501', 'L2c 편집자 설정 불가');
select test.expect_error(test.adcall('owner', 'ai_budget_limit_set', $$-1, '시험'$$), '22023', 'L3 음수 거부');
select test.expect_error(test.adcall('owner', 'ai_budget_limit_set', $$100001, '시험'$$), '22023', 'L3b 상한(100,000원) 초과 거부');
select test.expect_error(test.adcall('owner', 'ai_budget_limit_set', $$null, '시험'$$), '22023', 'L3c null 거부');
select test.expect_error(test.adcall('owner', 'ai_budget_limit_set', $$100, ' '$$), '22023', 'L3d 사유 필수');
select test.expect_ok(test.adcall('owner', 'ai_budget_limit_set', $$100, '개발용 시험 한도'$$), 'L4 대표 설정');
reset role;
select test.expect_eq($$select monthly_limit_krw::text from core.ai_budget_config where singleton$$, '100', 'L4b 설정 반영');
select test.expect_eq($$select detail->>'old_limit_krw' || '>' || (detail->>'new_limit_krw') from core.audit_logs where action = 'ai.budget_limit_set' order by id desc limit 1$$, '0>100', 'L4c 변경 전후가 감사 기록에 남음');
update core.ai_budget_config set monthly_limit_krw = 0 where singleton;
