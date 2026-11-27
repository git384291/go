-- 광고 launch 상태(0018). 가상 데이터만 사용한다. 실제 광고 API 없음.
\set ON_ERROR_STOP 1
create function test.lx(p_who text, p_fn text, p_args text, p_key text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
begin
  return format('select (%s)::jsonb ->> %L', substr(test.adcall(p_who, p_fn, p_args), 8), p_key);
end $$;

set role app_staff;
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-l', 'req-launch-0000001', 1000$$, 'ok'), 'true', 'L1 launch 시작(requested)');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-l', 'req-launch-0000001', 1000$$, 'reason'), 'DUPLICATE_REQUEST', 'L1b 같은 요청 키 재시작 거부');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-l', 'req-launch-0000002', 1000$$, 'reason'), 'LAUNCH_ACTIVE', 'L1c 캠페인당 열린 launch 1건(다른 키도 거부)');
select test.expect_error(test.adcall('editor', 'ad_launch_begin', $$'camp-x', 'req-launch-0000009', 1000$$), '42501', 'L1d 편집자 launch 불가');
select test.expect_error(test.adcall('reviewer', 'ad_launch_begin', $$'camp-x', 'req-launch-0000009', 1000$$), '42501', 'L1e 검토자 launch 불가');
select test.expect_error(test.adcall('counselor', 'ad_launch_begin', $$'camp-x', 'req-launch-0000009', 1000$$), '42501', 'L1f 상담원 launch 불가');
select test.expect_error(test.adcall('owner', 'ad_launch_begin', $$'Bad Key', 'req-launch-0000009', 1000$$), '22023', 'L1g 캠페인 키 형식 거부');
select test.expect_error(test.adcall('owner', 'ad_launch_begin', $$'camp-x', 'short', 1000$$), '22023', 'L1h 요청 키 형식 거부');
select test.expect_error(test.adcall('owner', 'ad_launch_begin', $$'camp-x', 'req-launch-0000009', 10001$$), '22023', 'L1i 금액 상한 거부');

-- 불명(unknown): 사람이 확인하기 전에는 재launch 금지
select test.expect_eq(test.lx('owner', 'ad_launch_finish', $$'req-launch-0000001', 'unknown', null, 'TIMEOUT'$$, 'ok'), 'true', 'L2 시간 초과 → unknown 기록');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-l', 'req-launch-0000003', 1000$$, 'reason'), 'LAUNCH_UNKNOWN', 'L2b unknown이 열려 있으면 새 launch 거부');
select test.expect_error(test.adcall('owner', 'ad_launch_finish', $$'req-launch-0000001', 'active', 'ext-1', null$$), '22023', 'L2c requested가 아니면 결과 기록 거부(NO_LAUNCH)');
select test.expect_error(test.adcall('owner', 'ad_launch_resolve', $$'req-launch-0000001', 'not_executed', null, ''$$), '22023', 'L3 확인 사유 필수');
select test.expect_error(test.adcall('editor', 'ad_launch_resolve', $$'req-launch-0000001', 'not_executed', null, '플랫폼 확인함'$$), '42501', 'L3b 편집자 정리 불가');
select test.expect_error(test.adcall('owner', 'ad_launch_resolve', $$'req-launch-0000001', 'executed', null, '플랫폼 확인함'$$), '22023', 'L3c executed는 externalId 필수');
select test.expect_eq(test.lx('owner', 'ad_launch_resolve', $$'req-launch-0000001', 'not_executed', null, '플랫폼 콘솔에서 집행 안 됨 확인'$$, 'ok'), 'true', 'L3d 사람이 확인 → failed');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-l', 'req-launch-0000004', 1000$$, 'ok'), 'true', 'L3e failed 뒤에는 새 launch 가능');

-- active: externalId 기준 조회·중지
select test.expect_error(test.adcall('owner', 'ad_launch_finish', $$'req-launch-0000004', 'active', null, null$$), '22023', 'L4 active는 externalId 필수');
select test.expect_error(test.adcall('owner', 'ad_launch_finish', $$'req-launch-0000004', 'active', 'ext-1', 'bad note'$$), '22023', 'L4b note는 고정 코드만');
select test.expect_eq(test.lx('owner', 'ad_launch_finish', $$'req-launch-0000004', 'active', 'ext-1', null$$, 'ok'), 'true', 'L4c 플랫폼 확인 → active');
select test.expect_eq(test.lx('reviewer', 'ad_launch_active', $$'camp-l'$$, 'external_id'), 'ext-1', 'L4d 검토자는 열린 launch 조회 가능(externalId)');
select test.expect_error(test.adcall('counselor', 'ad_launch_active', $$'camp-l'$$), '42501', 'L4e 상담원 조회 불가');
select test.expect_error(test.adcall('reviewer', 'ad_launch_paused', $$'camp-l'$$), '42501', 'L4f 검토자 중지 기록 불가');
select test.expect_eq(test.lx('owner', 'ad_launch_paused', $$'camp-l'$$, 'paused'), 'true', 'L5 중지 확인 → paused');
select test.expect_eq(test.lx('owner', 'ad_launch_paused', $$'camp-l'$$, 'paused'), 'false', 'L5b 이미 paused면 변화 없음');
select test.expect_eq(test.lx('reviewer', 'ad_launch_active', $$'camp-l'$$, 'state'), 'paused', 'L5b2 열린 launch가 없으면 가장 최근 paused를 돌려줌(마지막 성과 수집용)');
select test.expect_eq(test.lx('owner', 'ad_launch_begin', $$'camp-l', 'req-launch-0000005', 1000$$, 'ok'), 'true', 'L5c paused 뒤 새 launch 가능(승인은 별도)');
select test.expect_error($$select * from core.ad_launches$$, '42501', 'L6 앱 역할은 launch 테이블 직접 조회 불가');
reset role;

-- 가드: 삭제·잘못된 전이·식별 필드 변경 불가
select test.expect_error($$delete from core.ad_launches$$, '42501', 'L7 삭제 불가');
select test.expect_error($$update core.ad_launches set state = 'requested' where request_key = 'req-launch-0000004'$$, '42501', 'L7b paused를 되돌릴 수 없음');
select test.expect_error($$update core.ad_launches set amount_krw = 1 where request_key = 'req-launch-0000005'$$, '42501', 'L7c 금액 변경 불가');
select test.expect_error($$update core.ad_launches set external_id = 'x' where request_key = 'req-launch-0000004'$$, '42501', 'L7d externalId 변경 불가');
select test.expect_error($$insert into core.ad_launches (campaign_key, request_key, amount_krw, created_by) values ('camp-l', 'req-launch-0000006', 1000, gen_random_uuid())$$, '23505', 'L7e 열린 launch 중복은 유니크 인덱스도 막음');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'ad.launch_%'$$, '7', 'L8 launch 감사 기록 7건(시작3·불명1·정리1·active1·paused1)');
select test.expect_eq($$select count(*)::text from core.audit_logs a where a.action like 'ad.launch_%' and to_jsonb(a)::text ~ '(ext-1|secret|token)'$$, '0', 'L8b 감사 기록에 externalId·키 원문 없음');
