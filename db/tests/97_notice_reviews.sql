-- 총판 고지 조건 관리자 검수 기록(0015). 앞선 시험(96)이 대표로 입력한 'draft-v1' 문구를 사용한다. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
set role app_staff;
select test.expect_error(test.adcall('editor', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":true}'::jsonb, 'approved', '정책 담당 시도'$$), '42501', 'Y1 정책 담당 검수 불가');
select test.expect_error(test.adcall('counselor', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":true}'::jsonb, 'approved', '상담원 시도'$$), '42501', 'Y1b 상담원 검수 불가');
select test.expect_error(test.adcall('reviewer', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":false,"screen_checked":true}'::jsonb, 'approved', '조건 미확인'$$), '22023', 'Y2 확인 항목이 하나라도 false면 승인 불가');
select test.expect_error(test.adcall('reviewer', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true}'::jsonb, 'approved', '항목 부족'$$), '22023', 'Y2b 항목 수 부족 거부');
select test.expect_error(test.adcall('reviewer', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":"yes"}'::jsonb, 'approved', '값 형식'$$), '22023', 'Y2c 불리언 아닌 값 거부');
select test.expect_error(test.adcall('reviewer', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":true}'::jsonb, 'approved', ''$$), '22023', 'Y2d 사유 필수');
select test.expect_error(test.adcall('reviewer', 'notice_review_add', $$'no-such-v', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":true}'::jsonb, 'approved', '없는 버전'$$), '22023', 'Y2e DB에 문구 없는 버전은 검수 불가');
select test.expect_error_msg(test.adcall('owner', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":true}'::jsonb, 'approved', '자기 입력 승인'$$), '42501', 'SELF_APPROVAL', 'Y3 문구를 입력한 대표는 같은 버전을 승인할 수 없음');
reset role;
select test.expect_eq($$select count(*)::text from core.notice_reviews$$, '0', 'Y3b 거부된 요청은 기록을 남기지 않음');
set role app_staff;
select test.expect_ok(test.adcall('owner', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":false,"screen_checked":true}'::jsonb, 'rejected', '조건 확인 필요'$$), 'Y4 대표는 반려는 기록 가능');
select test.expect_ok(test.adcall('reviewer', 'notice_review_add', $$'draft-v1', '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":true}'::jsonb, 'approved', '원문 대조·조건 확인 완료'$$), 'Y5 검토자 승인');
select test.expect_ok(test.adcall0('owner', 'notice_review_list'), 'Y6 대표 이력 조회');
select test.expect_error(test.adcall0('editor', 'notice_review_list'), '42501', 'Y6b 정책 담당 이력 조회 불가');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action in ('notice.review_approved', 'notice.review_rejected') and detail ->> 'version' = 'draft-v1'$$, '2', 'Y7 검수마다 감사 기록(승인·반려)');
select test.expect_eq($$select count(*)::text from core.notice_reviews where decision = 'approved' and texts_sha256 = (select encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex') from core.notice_texts n where n.version = 'draft-v1')$$, '1', 'Y7b 승인 기록에 검수 시점 문구 묶음 해시');
select test.expect_error($$update core.notice_reviews set decision = 'approved'$$, '42501', 'Y8 검수 기록 수정 불가');
select test.expect_error($$delete from core.notice_reviews$$, '42501', 'Y8b 삭제 불가');
select test.expect_error($$truncate core.notice_reviews$$, '42501', 'Y8c 비우기 불가');
-- 문구가 더 추가되면 이전 승인은 최신이 아니다
set role app_staff;
select test.expect_ok(test.adcall('owner', 'notice_text_add', $$'draft-v1', 'second_key', '두 번째 가상 문구(시험용)', '항목 추가 시험'$$), 'Y9 승인 뒤 문구 추가');
reset role;
select test.expect_eq($$select count(*)::text from core.notice_reviews where decision = 'approved' and texts_sha256 <> (select encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex') from core.notice_texts n where n.version = 'draft-v1')$$, '1', 'Y9b 이전 승인은 새 문구 묶음과 해시가 달라 최신 아님');
