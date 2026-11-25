-- 정책 작성 → 승인 → 게시 검증 (0004). 실제 역할 전환(set role app_staff / app_public) 상태에서 실행한다.
-- 단계 번호(S1~S9)는 PM 검증 요청 9단계와 같다.
\set ON_ERROR_STOP 1

-- 테이블 소유 측 역할(fideon_api)로 직접 우회 시도를 확인하기 위해, 테스트 DB에서만 검사 함수 실행을 허용한다
grant usage on schema test to fideon_api;
grant execute on function test.expect_error(text, text, text), test.expect_eq(text, text, text), test.expect_ok(text, text) to fideon_api;

-- 테스트 계정: owner(…01/세션 …01), counselor(…02/…02), reviewer(…05/…05), policy_editor(…06/…08)
select set_config('p.owner',  test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'), false);
select set_config('p.couns',  test.staff_token('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002'), false);
select set_config('p.review', test.staff_token('00000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005'), false);
select set_config('p.editor', test.staff_token('00000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000008'), false);
select set_config('p.revoked', test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007'), false);

-- 짧게 쓰기 위한 매크로(psql 변수)
\set OWN '''00000000-0000-4000-8000-000000000001'', ''10000000-0000-4000-8000-000000000001'', current_setting(''p.owner'')'
\set REV '''00000000-0000-4000-8000-000000000005'', ''10000000-0000-4000-8000-000000000005'', current_setting(''p.review'')'
\set EDI '''00000000-0000-4000-8000-000000000006'', ''10000000-0000-4000-8000-000000000008'', current_setting(''p.editor'')'
\set CNS '''00000000-0000-4000-8000-000000000002'', ''10000000-0000-4000-8000-000000000002'', current_setting(''p.couns'')'

set role app_staff;

-- S1 관리자 로그인(세션) 및 권한 확인
select test.expect_eq('select role from api.whoami(' || :'OWN' || ')', 'owner', 'P-S1a 대표 세션 확인 = owner');
select test.expect_eq('select role from api.whoami(' || :'EDI' || ')', 'policy_editor', 'P-S1b 정책 작성자 세션 확인 = policy_editor');
select test.expect_eq('select role from api.whoami(' || :'REV' || ')', 'reviewer', 'P-S1c 검수자 세션 확인 = reviewer');
select test.expect_error($$select api.policy_list('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007',
  current_setting('p.revoked'), null)$$, '42501', 'P-S1d 로그아웃된 세션으로 정책 목록 거부');

-- S2 테스트 정책 작성 및 DB 저장
select set_config('p.v2', api.policy_create('00000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000008',
  current_setting('p.editor'), 'privacy', 'privacy-test-v2', '개인정보처리방침 테스트 v2 본문')::text, false);
select test.expect_eq('select status from api.policy_list(' || :'EDI' || ', ''privacy'') where id = ''' || current_setting('p.v2') || '''',
  'draft', 'P-S2a 작성 직후 상태 draft');
select test.expect_error($$select api.policy_create('00000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
  current_setting('p.review'), 'privacy', 'privacy-test-x', 'x')$$, '42501', 'P-S2b 검수자는 작성 불가');
select test.expect_error($$select api.policy_create('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
  current_setting('p.couns'), 'privacy', 'privacy-test-x', 'x')$$, '42501', 'P-S2c 상담원은 작성 불가');
select test.expect_error($$select api.policy_create('00000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000008',
  current_setting('p.editor'), 'privacy', 'privacy-test-v2', '다른 본문')$$, '23505', 'P-S2d 같은 버전 중복 작성 거부');
select test.expect_error($$select api.policy_create('00000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000008',
  current_setting('p.editor'), 'privacy', 'Bad Version!', 'x')$$, '23514', 'P-S2e 잘못된 버전 형식 거부');
reset role;
select test.expect_eq($$select (body_sha256 = encode(extensions.digest(convert_to(body, 'UTF8'), 'sha256'), 'hex'))::text
  || '/' || created_by from core.policy_documents where id = current_setting('p.v2')::uuid$$,
  'true/00000000-0000-4000-8000-000000000006', 'P-S2f DB 저장 확인(본문 해시 일치, 작성자 기록)');
set role app_staff;

-- S3 승인 전 게시 차단 (기능 스위치를 먼저 켠다 — 스위치 꺼짐 차단은 S8에서 따로 확인)
select test.expect_ok($$select api.set_feature_flag('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('p.owner'), 'policy_publish', true, '정책 게시 검증')$$, 'P-S3a 대표가 정책 게시 스위치 켬');
select test.expect_error('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v2') || ''', ''승인 전 게시 시도'')',
  '55000', 'P-S3b 승인 전 게시 거부(NOT_APPROVED)');
reset role;
select test.expect_eq($$select count(*)::text from core.policy_documents where status = 'published'$$, '0', 'P-S3c 차단 후 게시 문서 0건');
set role app_staff;

-- S4 관리자 정책 승인 (직무 분리)
select test.expect_error('select api.policy_approve(' || :'EDI' || ', ''' || current_setting('p.v2') || ''', ''셀프 승인'')',
  '42501', 'P-S4a 작성자(정책 작성 권한)는 승인 불가');
select test.expect_error('select api.policy_approve(' || :'CNS' || ', ''' || current_setting('p.v2') || ''', ''상담원 승인'')',
  '42501', 'P-S4b 상담원 승인 불가');
select test.expect_error('select api.policy_approve(' || :'REV' || ', ''' || current_setting('p.v2') || ''', '''')',
  '22023', 'P-S4c 승인 사유 없으면 거부');
select test.expect_ok('select api.policy_approve(' || :'REV' || ', ''' || current_setting('p.v2') || ''', ''문구 검수 완료'')',
  'P-S4d 검수자 승인');
select test.expect_error('select api.policy_approve(' || :'REV' || ', ''' || current_setting('p.v2') || ''', ''두 번째 승인'')',
  '55000', 'P-S4e 이미 승인된 문서 재승인 거부');
-- 대표가 직접 작성한 문서를 대표 본인이 승인하는 경우
select set_config('p.self', api.policy_create('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('p.owner'), 'terms', 'terms-test-v1', '이용약관 테스트 v1')::text, false);
select test.expect_error('select api.policy_approve(' || :'OWN' || ', ''' || current_setting('p.self') || ''', ''셀프 승인'')',
  '42501', 'P-S4f 대표도 본인 작성 문서 승인 불가(SELF_APPROVAL)');

-- S5 승인된 정책 게시 (owner만)
select test.expect_error('select api.policy_publish(' || :'REV' || ', ''' || current_setting('p.v2') || ''', ''검수자 게시'')',
  '42501', 'P-S5a 검수자 게시 불가');
select test.expect_error('select api.policy_publish(' || :'EDI' || ', ''' || current_setting('p.v2') || ''', ''작성자 게시'')',
  '42501', 'P-S5b 작성자 게시 불가');
select test.expect_eq('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v2') || ''', ''v2 게시'')',
  'privacy-test-v2', 'P-S5c 대표 게시 성공');

-- S6 실제 DB에 게시 상태와 정책 버전 반영
reset role;
select test.expect_eq($$select status || '/' || published_by || '/' || (published_at is not null)::text
  from core.policy_documents where id = current_setting('p.v2')::uuid$$,
  'published/00000000-0000-4000-8000-000000000001/true', 'P-S6a DB 상태 published, 게시자·시각 기록');
select test.expect_eq($$select value #>> '{}' from core.settings where key = 'privacy_policy_version'$$,
  'privacy-test-v2', 'P-S6b 설정 privacy_policy_version = v2 (상담 신청 동의 버전에 반영)');
-- 게시 반영 효과: 이전 버전(v1)에 동의한 상담 신청은 거부, 새 버전(v2) 동의는 접수
select set_config('p.lead_old', test.lead_sql(repeat('4', 64), 'idem-policy-000000001', p_version => 'privacy-test-v1', p_ip => repeat('3', 64)), false);
select set_config('p.lead_new', test.lead_sql(repeat('4', 64), 'idem-policy-000000002', p_version => 'privacy-test-v2', p_ip => repeat('3', 64)), false);
set role app_public;
select test.expect_error(current_setting('p.lead_old'), '22023', 'P-S6c 이전 정책 버전 동의로 상담 신청 거부(CONSENT_VERSION_MISMATCH)');
select test.expect_ok(current_setting('p.lead_new'), 'P-S6d 새 정책 버전 동의로 상담 신청 접수');
reset role;
select test.expect_eq($$select count(*)::text from pii.consents where doc_version = 'privacy-test-v2'$$, '1', 'P-S6e 동의 기록에 새 버전 저장');

-- S7 최신 게시 조회 + 이전 정책 비활성화
set role app_staff;
select set_config('p.v3', api.policy_create('00000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000008',
  current_setting('p.editor'), 'privacy', 'privacy-test-v3', '개인정보처리방침 테스트 v3 본문')::text, false);
select test.expect_ok('select api.policy_approve(' || :'REV' || ', ''' || current_setting('p.v3') || ''', ''v3 검수'')', 'P-S7a v3 승인');
select test.expect_eq('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v3') || ''', ''v3 게시'')',
  'privacy-test-v3', 'P-S7b v3 게시');
reset role;
set role app_public;
select test.expect_eq($$select version from api.policy_current('privacy')$$, 'privacy-test-v3', 'P-S7c 공개 조회 = 최신 v3');
select test.expect_eq($$select count(*)::text from api.policy_current('privacy')$$, '1', 'P-S7d 공개 조회 결과 1건');
reset role;
select test.expect_eq($$select status || '/' || (retired_at is not null)::text from core.policy_documents
  where id = current_setting('p.v2')::uuid$$, 'retired/true', 'P-S7e 이전 v2 비활성화(retired)');
select test.expect_eq($$select count(*)::text from core.policy_documents where kind = 'privacy' and status = 'published'$$,
  '1', 'P-S7f privacy 게시 문서 정확히 1건');
select test.expect_eq($$select value #>> '{}' from core.settings where key = 'privacy_policy_version'$$,
  'privacy-test-v3', 'P-S7g 설정 버전 v3로 갱신');

-- S8 비인가 접근·권한 우회·중복 게시 차단
set role app_staff;
select test.expect_error('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v3') || ''', ''중복 게시'')',
  '55000', 'P-S8a 이미 게시된 v3 중복 게시 거부');
select test.expect_error('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v2') || ''', ''폐기본 재게시'')',
  '55000', 'P-S8b 폐기(retired) v2 재게시 거부');
select test.expect_error($$select api.policy_publish('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '1.9999999999.' || repeat('0', 64), current_setting('p.v3')::uuid, '위조')$$, '42501', 'P-S8c 위조 서명으로 게시 거부');
select test.expect_error($$select api.policy_publish('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('p.review'), current_setting('p.v3')::uuid, '검수자 서명으로 대표 행세')$$, '42501', 'P-S8d 다른 사람 서명으로 대표 행세 거부');
select test.expect_error($$update core.policy_documents set status = 'published'$$, '42501', 'P-S8e 관리자 역할 테이블 직접 수정 불가');
select test.expect_error($$select * from core.policy_documents$$, '42501', 'P-S8f 관리자 역할 테이블 직접 조회 불가');
-- 스위치 꺼짐 상태에서 게시 차단
select set_config('p.v4', api.policy_create('00000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000008',
  current_setting('p.editor'), 'privacy', 'privacy-test-v4', '개인정보처리방침 테스트 v4 본문')::text, false);
select test.expect_ok('select api.policy_approve(' || :'REV' || ', ''' || current_setting('p.v4') || ''', ''v4 검수'')', 'P-S8g v4 승인');
select test.expect_ok($$select api.set_feature_flag('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('p.owner'), 'policy_publish', false, '스위치 차단 확인')$$, 'P-S8h 게시 스위치 끔');
select test.expect_error('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v4') || ''', ''스위치 꺼짐'')',
  '55000', 'P-S8i 스위치 꺼짐이면 게시 거부(FEATURE_DISABLED)');
select test.expect_ok($$select api.set_feature_flag('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('p.owner'), 'policy_publish', true, '복구 검증 준비')$$, 'P-S8j 게시 스위치 다시 켬');
reset role;
set role app_public;
select test.expect_error($$select api.policy_publish('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  current_setting('p.owner'), current_setting('p.v4')::uuid, '공개 역할')$$, '42501', 'P-S8k 공개 역할은 게시 함수 실행 불가');
select test.expect_error($$select * from api.policy_list(null, null, null, null)$$, '42501', 'P-S8l 공개 역할은 관리자 목록 실행 불가');
reset role;
-- 함수 우회: 테이블 소유 측 역할로 직접 수정해도 트리거가 막는다
set role fideon_api;
select test.expect_error($$update core.policy_documents set body = '몰래 수정' where id = current_setting('p.v3')::uuid$$,
  '42501', 'P-S8m 게시본 본문 변경 불가(POLICY_IMMUTABLE)');
select test.expect_error($$update core.policy_documents set status = 'draft', approved_by = null, approved_at = null
  where id = current_setting('p.v4')::uuid$$, '55000', 'P-S8n 상태 되돌리기 불가(INVALID_TRANSITION)');
select test.expect_error($$update core.policy_documents set status = 'published', published_at = now()
  where id = current_setting('p.v4')::uuid$$, '23505', 'P-S8o 함수 우회 직접 게시해도 게시본 2개 불가(유일 인덱스)');
select test.expect_error($$delete from core.policy_documents where id = current_setting('p.v2')::uuid$$,
  '42501', 'P-S8p 정책 문서 삭제 불가');
reset role;

-- S9 감사 기록 + 실패 시 복구
select test.expect_eq($$select string_agg(action || ':' || actor_id, ',' order by id) from core.audit_logs
  where target_id in (current_setting('p.v2')::uuid, current_setting('p.v3')::uuid)$$,
  'policy.create:00000000-0000-4000-8000-000000000006,policy.approve:00000000-0000-4000-8000-000000000005,policy.publish:00000000-0000-4000-8000-000000000001,'
  || 'policy.create:00000000-0000-4000-8000-000000000006,policy.approve:00000000-0000-4000-8000-000000000005,policy.publish:00000000-0000-4000-8000-000000000001',
  'P-S9a 작성·승인·게시 감사 기록(행위자 포함) 순서대로 존재');
select test.expect_eq($$select detail->>'previous_version' from core.audit_logs
  where action = 'policy.publish' and target_id = current_setting('p.v3')::uuid$$, 'privacy-test-v2', 'P-S9b 게시 감사에 이전 버전 기록');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'policy.publish'
  and target_id in (current_setting('p.v2')::uuid, current_setting('p.v3')::uuid, current_setting('p.v4')::uuid)
  and (reason is null or length(reason) < 2)$$, '0', 'P-S9c 게시 감사 사유 누락 0건');
set role fideon_api;
select test.expect_error($$update core.audit_logs set reason = '변조' where action = 'policy.publish'$$, '42501', 'P-S9d 감사 기록 수정 불가');
select test.expect_error($$delete from core.audit_logs where action = 'policy.publish'$$, '42501', 'P-S9e 감사 기록 삭제 불가');
reset role;

-- 복구: 게시 마지막 단계(감사 기록 저장)에서 장애를 일부러 일으킨다 → 전체 취소되어야 한다
create function test.fail_publish_audit() returns trigger language plpgsql as $$
begin
  if new.action = 'policy.publish' then raise exception 'SIMULATED_FAILURE'; end if;
  return new;
end $$;
create trigger zz_test_fail before insert on core.audit_logs for each row execute function test.fail_publish_audit();
set role app_staff;
select test.expect_error('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v4') || ''', ''장애 중 게시'')',
  'P0001', 'P-S9f 게시 중 장애 발생');
reset role;
select test.expect_eq($$select string_agg(version || '=' || status, ',' order by version) from core.policy_documents where kind = 'privacy'$$,
  'privacy-test-v2=retired,privacy-test-v3=published,privacy-test-v4=approved', 'P-S9g 장애 후 상태 그대로(v3 게시 유지, v4 승인 상태)');
select test.expect_eq($$select value #>> '{}' from core.settings where key = 'privacy_policy_version'$$,
  'privacy-test-v3', 'P-S9h 장애 후 설정 버전 v3 유지');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'policy.publish' and target_id = current_setting('p.v4')::uuid$$,
  '0', 'P-S9i 장애 건 게시 감사 기록 없음(반쪽 기록 없음)');
drop trigger zz_test_fail on core.audit_logs;
drop function test.fail_publish_audit();
set role app_staff;
select test.expect_eq('select api.policy_publish(' || :'OWN' || ', ''' || current_setting('p.v4') || ''', ''장애 복구 후 재게시'')',
  'privacy-test-v4', 'P-S9j 장애 해소 후 재시도 성공');
reset role;
select test.expect_eq($$select string_agg(version || '=' || status, ',' order by version) from core.policy_documents where kind = 'privacy'$$,
  'privacy-test-v2=retired,privacy-test-v3=retired,privacy-test-v4=published', 'P-S9k 복구 후 최종 상태 정상');
