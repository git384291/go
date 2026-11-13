-- SEC-01 관리자 세션 인증: 실제 역할 전환(set role app_staff) 상태에서 공격·우회 시도
\set ON_ERROR_STOP 1

-- 관리자 연결에서 유효 토큰을 미리 만들어 세션 설정값에 넣어 둔다(테스트 전용)
select set_config('t.owner',      test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'), false);
select set_config('t.counselor',  test.staff_token('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002'), false);
select set_config('t.inactive',   test.staff_token('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003'), false);
select set_config('t.expired',    test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000006'), false);
select set_config('t.revoked',    test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007'), false);
-- 상담원 본인 토큰이지만 대표의 세션 ID와 묶어 서명한 경우(서버가 절대 만들지 않는 조합)
select set_config('t.cross',      test.staff_token('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001'), false);
select set_config('t.stale',      test.token('staff', array['00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'], -10), false);
select set_config('t.wrongkey',   test.token('lead',  array['00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001']), false);

set role app_staff;

select test.expect_ok($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('t.owner'), 50, 0)$$, 'A1 정상 대표 세션 통과');

-- 세션 ID만 아는 경우 (서명 없음/위조)
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  null, 50, 0)$$, '42501', 'A2 세션 ID만 전달(서명 없음) 거부');
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '1.9999999999.' || repeat('0', 64), 50, 0)$$, '42501', 'A3 위조 서명 거부');

-- 다른 관리자의 세션 ID 사용
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  current_setting('t.counselor'), 50, 0)$$, '42501', 'A4 상담원 서명 + 대표 세션 ID 거부');
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('t.counselor'), 50, 0)$$, '42501', 'A5 상담원 서명으로 대표 행세 거부');
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  current_setting('t.cross'), 50, 0)$$, '42501', 'A6 유효 서명이라도 세션 소유자 불일치면 거부');

-- 세션 상태
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
  current_setting('t.inactive'), 50, 0)$$, '42501', 'A7 비활성 관리자 거부');
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000006',
  current_setting('t.expired'), 50, 0)$$, '42501', 'A8 12시간 초과 세션 거부');
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007',
  current_setting('t.revoked'), 50, 0)$$, '42501', 'A9 로그아웃(취소)된 세션 거부');
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('t.stale'), 50, 0)$$, '42501', 'A10 만료된 서명 거부');
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('t.wrongkey'), 50, 0)$$, '42501', 'A11 다른 용도 키(lead)로 만든 서명 거부');

-- v2 방식 설정값 위조
select set_config('app.actor_role', 'owner', false), set_config('app.actor_id', '00000000-0000-4000-8000-000000000001', false),
       set_config('request.jwt.claims', '{"role":"owner","aal":"aal2"}', false);
select test.expect_error($$select * from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', null, 50, 0)$$,
  '42501', 'A12 사용자 정의 설정값 위조 무효');

-- 세션 생성 함수에 일반 요청 토큰을 넣어 다른 사람 세션 만들기
select test.expect_error($$select api.staff_session_open('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-0000000000aa',
  current_setting('t.counselor'))$$, '42501', 'A13 일반 토큰으로 세션 생성 불가');

-- 테이블·내부 함수 직접 접근
select test.expect_error($$select * from security.staff_sessions$$, '42501', 'A14 세션 테이블 직접 조회 불가');
select test.expect_error($$select * from security.server_keys$$, '42501', 'A15 서명 키 직접 조회 불가');
select test.expect_error($$select security.verify_token('staff', 'x', array['a'])$$, '42501', 'A16 서명 검증 함수 직접 호출 불가');
select test.expect_error($$select * from core.leads$$, '42501', 'A17 리드 테이블 직접 조회 불가');
select test.expect_error($$select * from pii.customers$$, '42501', 'A18 고객 암호문 테이블 직접 조회 불가');
select test.expect_error($$insert into security.staff_sessions (id, user_id) values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001')$$,
  '42501', 'A19 세션 직접 생성 불가');

reset role;

-- 로그아웃 후 즉시 무효
select set_config('t.c2', test.staff_token('00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004'), false);
set role app_staff;
select test.expect_ok($$select api.staff_session_revoke('00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
  current_setting('t.c2'))$$, 'A20 로그아웃 처리');
select test.expect_error($$select * from api.whoami('00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
  current_setting('t.c2'))$$, '42501', 'A21 로그아웃 직후 같은 토큰 거부');
reset role;
-- 이후 테스트를 위해 세션 복구
update security.staff_sessions set revoked_at = null where id = '10000000-0000-4000-8000-000000000004';
