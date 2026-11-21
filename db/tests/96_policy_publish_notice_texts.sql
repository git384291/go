-- 정책 게시 ON/OFF(대표 전용)와 필수 고지 문구 관리(0014). 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1
reset role;
update core.feature_flags set enabled = false where key = 'policy_publish';  -- 앞선 시험(60)이 켜 둔 값을 초기 상태(OFF)로 되돌려 시작
select test.expect_eq($$select enabled::text from core.feature_flags where key = 'policy_publish'$$, 'false', 'X0 게시 스위치 OFF에서 시작');
set role app_staff;
select test.expect_ok(test.adcall0('owner', 'policy_publish_get'), 'X1 대표 조회');
select test.expect_ok(test.adcall0('editor', 'policy_publish_get'), 'X1b 정책 담당 조회');
select test.expect_ok(test.adcall0('reviewer', 'policy_publish_get'), 'X1c 검토자 조회');
select test.expect_error(test.adcall0('counselor', 'policy_publish_get'), '42501', 'X1d 상담원 조회 불가');
-- 변경은 대표만
select test.expect_error(test.adcall('editor', 'policy_publish_set', $$true, '정책 담당 시도'$$), '42501', 'X2 정책 담당 변경 불가');
select test.expect_error(test.adcall('reviewer', 'policy_publish_set', $$true, '검토자 시도'$$), '42501', 'X2b 검토자 변경 불가');
select test.expect_error(test.adcall('counselor', 'policy_publish_set', $$true, '상담원 시도'$$), '42501', 'X2c 상담원 변경 불가');
select test.expect_error(test.adcall('owner', 'policy_publish_set', $$true, ' '$$), '22023', 'X2d 사유 필수');
select test.expect_error(test.adcall('owner', 'policy_publish_set', $$null, '사유 있음'$$), '22023', 'X2e 값 null 거부');
reset role;
select test.expect_eq($$select enabled::text from core.feature_flags where key = 'policy_publish'$$, 'false', 'X3 거부된 요청은 스위치를 바꾸지 않음');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'policy.publish%'$$, '0', 'X3b 거부는 감사 기록을 만들지 않음');
set role app_staff;
select test.expect_ok(test.adcall('owner', 'policy_publish_set', $$true, '검수용 환경 게시 시험'$$), 'X4 대표 게시 ON');
reset role;
select test.expect_eq($$select enabled::text from core.feature_flags where key = 'policy_publish'$$, 'true', 'X4b ON 반영');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'policy.publish_on' and detail = '{"old": false, "new": true}'::jsonb and reason = '검수용 환경 게시 시험'$$, '1', 'X4c 감사 기록(변경 전후·사유)');
set role app_staff;
select test.expect_ok(test.adcall('owner', 'policy_publish_set', $$false, '시험 종료'$$), 'X5 대표 게시 OFF');
reset role;
select test.expect_eq($$select enabled::text from core.feature_flags where key = 'policy_publish'$$, 'false', 'X5b OFF 반영');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'policy.publish_off'$$, '1', 'X5c 중단 감사 기록');
-- 고지 문구: 추가 전용·대표만·형식·중복
set role app_staff;
select test.expect_error(test.adcall('editor', 'notice_text_add', $$'draft-v1', 'sample_key', '가상 문구', '시험'$$), '42501', 'X6 정책 담당 추가 불가');
select test.expect_error(test.adcall('reviewer', 'notice_text_add', $$'draft-v1', 'sample_key', '가상 문구', '시험'$$), '42501', 'X6b 검토자 추가 불가');
select test.expect_error(test.adcall('owner', 'notice_text_add', $$'bad version!', 'sample_key', '가상 문구', '시험'$$), '22023', 'X6c 버전 형식');
select test.expect_error(test.adcall('owner', 'notice_text_add', $$'draft-v1', 'Bad-Key', '가상 문구', '시험'$$), '22023', 'X6d 키 형식');
select test.expect_error(test.adcall('owner', 'notice_text_add', $$'draft-v1', 'sample_key', ' ', '시험'$$), '22023', 'X6e 빈 문구');
select test.expect_error(test.adcall('owner', 'notice_text_add', $$'draft-v1', 'sample_key', '가상 문구', ''$$), '22023', 'X6f 사유 필수');
select test.expect_ok(test.adcall('owner', 'notice_text_add', $$'draft-v1', 'sample_key', '가상 문구(시험용, 실제 고지 아님)', '입력 화면 시험'$$), 'X7 대표 추가');
select test.expect_error_msg(test.adcall('owner', 'notice_text_add', $$'draft-v1', 'sample_key', '다른 문구', '덮어쓰기 시도'$$), '22023', 'NOTICE_EXISTS', 'X7b 같은 버전·키는 덮어쓰기 불가');
select test.expect_ok(test.adcall0('owner', 'notice_text_list'), 'X8 대표 목록');
select test.expect_ok(test.adcall0('reviewer', 'notice_text_list'), 'X8b 검토자 목록');
select test.expect_error(test.adcall0('editor', 'notice_text_list'), '42501', 'X8c 정책 담당 목록 불가');
reset role;
select test.expect_eq($$select count(*)::text from core.notice_texts where version = 'draft-v1' and body_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex')$$, '1', 'X9 서버가 문구 해시를 계산해 저장');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'notice.text_add' and detail->>'version' = 'draft-v1' and detail->>'sha256' = (select body_sha256 from core.notice_texts where version = 'draft-v1')$$, '1', 'X9b 추가 감사 기록(버전·키·해시, 문구 원문 없음)');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'notice.text_add' and detail::text like '%가상 문구%'$$, '0', 'X9c 감사에 문구 원문 없음');
select test.expect_error($$update core.notice_texts set body = 'x' where version = 'draft-v1'$$, '42501', 'X10 기존 문구 수정 불가(추가 전용)');
select test.expect_error($$delete from core.notice_texts where version = 'draft-v1'$$, '42501', 'X10b 삭제 불가');
update core.feature_flags set enabled = true where key = 'policy_publish';  -- 뒤 시험(K5 등)이 기대하는 이전 상태로 복구
