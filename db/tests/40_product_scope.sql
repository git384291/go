-- PHASE 1: 상품 상태 · 예약 상품 접수 차단 · 활성화 2인 승인 검증
-- 가상 데이터만 사용한다. 이 파일은 관리자(마이그레이션) 연결로 실행되며,
-- 테이블 직접 조작 시험은 'DB 관리자 계정으로 직접 넣어도 서명 없이는 안 된다'를 확인하는 것이다.
\set ON_ERROR_STOP 1

-- 상품을 바꿔 가며 서버와 같은 서명 호출문을 만든다(서명은 유효 = 서버 코드가 활성으로 판단한 상황을 가정)
create function test.lead_sql_for(p_interest text, p_hmac text, p_idem text, p_ip text) returns text
language plpgsql as $$
declare
  f text[] := array['v1:enc-name', '테*고', 'v1:enc-phone', p_hmac, '1234', p_interest, '',
                    'naver', 'cpc', 'test', p_idem, 'privacy-test-v1', 'true', 'false', p_ip];
begin
  return format('select api.create_lead(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L::boolean, %L::boolean, %L)',
                test.token('lead', f), f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9], f[10], f[11], f[12], f[13], f[14], f[15]);
end
$$;

-- 승인 기록 SQL. p_sign_* 를 주면 서명 대상과 실제 값을 다르게 만든다(재사용·변조 시험)
create function test.approval_sql(p_staff uuid, p_session uuid, p_product text, p_kind text,
                                  p_sign_product text default null, p_sign_kind text default null,
                                  p_proof text default '') returns text
language plpgsql as $$
declare
  v_proof text := case when p_proof = '' then
    test.token('staff', array['product-approve', p_staff::text, p_session::text,
                              coalesce(p_sign_product, p_product), coalesce(p_sign_kind, p_kind)])
    else p_proof end;
begin
  return format('insert into core.product_activation_approvals (product_key, approval_kind, staff_id, session_id, reason, proof, created_at)'
                ' values (%L, %L, %L, %L, %L, %L, now() - interval ''30 days'')',
                p_product, p_kind, p_staff, p_session, '테스트 승인', v_proof);
end
$$;

-- 시드 계정: 01 owner(세션 01, 13시간 지난 세션 06, 폐기된 세션 07) · 02 counselor · 03 비활성 owner · 05 reviewer
\set OWNER '''00000000-0000-4000-8000-000000000001''::uuid, ''10000000-0000-4000-8000-000000000001''::uuid'
\set PM    '''00000000-0000-4000-8000-000000000005''::uuid, ''10000000-0000-4000-8000-000000000005''::uuid'

-- ===== 기준 상태 =====
select test.expect_eq($$select string_agg(product_key, ',' order by product_key) from core.product_catalog where status = 'active'$$,
  'internet_tv', 'PS1 DB 활성 상품은 인터넷+TV 하나');
select test.expect_eq($$select string_agg(product_key, ',' order by product_key) from core.product_catalog where status = 'reserved'$$,
  'cctv_security,internet_only,internet_phone,mobile,other', 'PS2 예약 상품(집전화·인터넷만·CCTV·기타·휴대폰), 동판 키 없음');

-- ===== 예약 상품 접수 차단(서명이 유효해도 DB가 거부) =====
select set_config('t.p_phone', test.lead_sql_for('internet_phone', repeat('a1', 32), 'idem-scope-00000001', repeat('a', 63) || '1'), false);
select set_config('t.p_only',  test.lead_sql_for('internet_only',  repeat('a2', 32), 'idem-scope-00000002', repeat('a', 63) || '2'), false);
select set_config('t.p_cctv',  test.lead_sql_for('cctv_security',  repeat('a3', 32), 'idem-scope-00000003', repeat('a', 63) || '3'), false);
select set_config('t.p_other', test.lead_sql_for('other',          repeat('a4', 32), 'idem-scope-00000004', repeat('a', 63) || '4'), false);
select set_config('t.p_mobile',test.lead_sql_for('mobile',         repeat('a5', 32), 'idem-scope-00000005', repeat('a', 63) || '5'), false);
select set_config('t.p_tv',    test.lead_sql_for('internet_tv',    repeat('a6', 32), 'idem-scope-00000006', repeat('a', 63) || '6'), false);

set role app_public;
select test.expect_error(current_setting('t.p_phone'),  'FP001', 'PS3 집전화 접수 → DB 거부(코드가 활성이라 잘못 판단해도 차단)');
select test.expect_error(current_setting('t.p_only'),   'FP001', 'PS4 인터넷만 접수 → DB 거부');
select test.expect_error(current_setting('t.p_cctv'),   'FP001', 'PS5 CCTV 접수 → DB 거부');
select test.expect_error(current_setting('t.p_other'),  'FP001', 'PS6 기타 접수 → DB 거부');
select test.expect_error(current_setting('t.p_mobile'), 'FP001', 'PS7 휴대폰 접수 → DB 거부');
select test.expect_eq(current_setting('t.p_tv'), 'accepted', 'PS8 인터넷+TV 접수는 그대로 동작(가상 DB)');
select test.expect_error($$select * from core.product_catalog$$, '42501', 'PS9 공개 역할은 상품 상태 조회·변경 불가');
reset role;
set role app_staff;
select test.expect_error($$update core.product_catalog set status = 'active' where product_key = 'cctv_security'$$, '42501',
  'PS10 관리자 역할도 상품 상태 직접 변경 불가');
select test.expect_error($$insert into core.product_activation_approvals (product_key, approval_kind, staff_id, session_id, reason)
  values ('cctv_security', 'owner', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'x')$$, '42501',
  'PS11 관리자 역할은 승인 기록 직접 입력 불가');
reset role;
select test.expect_eq($$select count(*)::text from core.leads where interest <> 'internet_tv' and idempotency_key like 'idem-scope-%'$$,
  '0', 'PS12 예약 상품 리드 저장 0건');

-- ===== 승인 없이 활성화 불가 (DB 관리자 계정으로 직접 시도) =====
select test.expect_error($$update core.product_catalog set status = 'active', activated_at = now() where product_key = 'cctv_security'$$,
  '42501', 'PS13 승인 0건 → 활성화 거부');
select test.expect_error(format($f$insert into core.product_activation_approvals (product_key, approval_kind, staff_id, session_id, reason)
  values ('cctv_security', 'owner', %L, %L, '대표 승인')$f$, '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
  '42501', 'PS14 승인자 ID만 적어 넣은 승인 기록 거부(서명 없음)');
select test.expect_error(test.approval_sql(:OWNER, 'cctv_security', 'owner', p_proof => '1.9999999999.' || repeat('0', 64)),
  '42501', 'PS15 위조 서명 거부');
select test.expect_error(test.approval_sql(:OWNER, 'cctv_security', 'owner', p_sign_product => 'internet_phone'),
  '42501', 'PS16 다른 상품용 서명 재사용 거부');
select test.expect_error(test.approval_sql(:OWNER, 'cctv_security', 'pm'),
  '42501', 'PS17 사용자(owner)가 PM 승인으로 기록 시도 거부');
select test.expect_error(test.approval_sql('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'cctv_security', 'owner'),
  '42501', 'PS18 상담원(counselor)의 사용자 승인 거부');
select test.expect_error(test.approval_sql('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'cctv_security', 'owner'),
  '42501', 'PS19 비활성 계정의 승인 거부');
select test.expect_error(test.approval_sql('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007', 'cctv_security', 'owner'),
  '42501', 'PS20 폐기된 세션의 승인 거부');
select test.expect_error(test.approval_sql('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000006', 'cctv_security', 'owner'),
  '42501', 'PS21 만료(12시간 초과) 세션의 승인 거부');
select test.expect_error(test.approval_sql(:OWNER, 'internet_tv', 'owner'),
  '22023', 'PS22 이미 활성인 상품에는 승인 기록 불가');

-- 사용자 승인만 있을 때
select test.expect_ok(test.approval_sql(:OWNER, 'cctv_security', 'owner'), 'PS23 유효한 사용자 승인 기록');
select test.expect_eq($$select (created_at > now() - interval '1 minute' and proof is null)::text
  from core.product_activation_approvals where product_key = 'cctv_security' and approval_kind = 'owner'$$,
  'true', 'PS24 승인 시각은 DB가 정함(과거 날짜 입력 무시), 서명은 저장 안 함');
select test.expect_error($$update core.product_catalog set status = 'active', activated_at = now() where product_key = 'cctv_security'$$,
  '42501', 'PS25 사용자 승인 1건만으로는 활성화 거부');

-- 승인 기록은 수정·삭제 불가
select test.expect_error($$update core.product_activation_approvals set staff_id = '00000000-0000-4000-8000-000000000005' where product_key = 'cctv_security'$$,
  '42501', 'PS26 승인 기록 승인자 변경 거부');
select test.expect_error($$update core.product_activation_approvals set approval_kind = 'pm' where product_key = 'cctv_security'$$,
  '42501', 'PS27 승인 종류 변경(사용자 → PM) 거부');
select test.expect_error($$delete from core.product_activation_approvals$$, '42501', 'PS28 승인 기록 삭제 거부');
select test.expect_error($$truncate core.product_activation_approvals$$, '42501', 'PS29 승인 기록 일괄 삭제(TRUNCATE) 거부');

-- 승인 후 PM 승인자가 비활성화되면 그 승인은 쓸 수 없다
select test.expect_ok(test.approval_sql(:PM, 'cctv_security', 'pm'), 'PS30 유효한 PM 승인 기록');
update core.staff set active = false where user_id = '00000000-0000-4000-8000-000000000005';
select test.expect_error($$update core.product_catalog set status = 'active', activated_at = now() where product_key = 'cctv_security'$$,
  '42501', 'PS31 승인 후 승인자 계정이 비활성화되면 활성화 거부');
update core.staff set active = true where user_id = '00000000-0000-4000-8000-000000000005';

-- 7일 지난 승인은 무효 (시험용으로만 트리거를 잠시 끄고 날짜를 과거로 옮긴다)
alter table core.product_activation_approvals disable trigger product_approval_guard;
update core.product_activation_approvals set created_at = now() - interval '8 days' where product_key = 'cctv_security';
alter table core.product_activation_approvals enable trigger product_approval_guard;
select test.expect_error($$update core.product_catalog set status = 'active', activated_at = now() where product_key = 'cctv_security'$$,
  '42501', 'PS32 7일 지난 승인으로는 활성화 거부');

-- 두 승인이 모두 유효하면 활성화(가상 DB에서 구조 검증만) → 접수 허용 → 다시 예약 → 접수 차단
select test.expect_ok(test.approval_sql(:OWNER, 'cctv_security', 'owner'), 'PS33 사용자 승인 재기록');
select test.expect_ok(test.approval_sql(:PM, 'cctv_security', 'pm'), 'PS34 PM 승인 재기록');
select test.expect_ok($$update core.product_catalog set status = 'active' where product_key = 'cctv_security'$$,
  'PS35 사용자 + PM 승인이 모두 있을 때만 활성화 성공');
select test.expect_eq($$select count(*)::text from core.product_activation_approvals where product_key = 'cctv_security' and consumed_at is null$$,
  '0', 'PS36 활성화에 쓰인 승인은 모두 소진');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'product.activate' and detail->>'product' = 'cctv_security'$$,
  '1', 'PS37 활성화 감사 기록(승인자 2명 포함)');
select set_config('t.p_cctv2', test.lead_sql_for('cctv_security', repeat('b3', 32), 'idem-scope-00000013', repeat('b', 63) || '3'), false);
set role app_public;
select test.expect_eq(current_setting('t.p_cctv2'), 'accepted', 'PS38 DB 활성화 후에만 DB 단계 통과(코드 상태는 별도 차단)');
reset role;

select test.expect_ok($$update core.product_catalog set status = 'reserved' where product_key = 'cctv_security'$$,
  'PS39 다시 예약 전환(안전 방향)은 승인 없이 가능');
select set_config('t.p_cctv3', test.lead_sql_for('cctv_security', repeat('c3', 32), 'idem-scope-00000023', repeat('c', 63) || '3'), false);
set role app_public;
select test.expect_error(current_setting('t.p_cctv3'), 'FP001', 'PS40 예약 전환 후 다시 접수 차단');
reset role;
select test.expect_error($$update core.product_catalog set status = 'active' where product_key = 'cctv_security'$$,
  '42501', 'PS41 소진된 승인으로 재활성화 거부(1회용)');

-- 상품 상태 테이블 보호
select test.expect_error($$delete from core.product_catalog where product_key = 'internet_phone'$$, '42501', 'PS42 상품 행 삭제 거부');
select test.expect_error($$truncate core.product_catalog cascade$$, '42501', 'PS43 상품 테이블 일괄 삭제 거부');
select test.expect_error($$insert into core.product_catalog (product_key, label, status, activated_at) values ('mobile', '휴대폰', 'active', now())$$,
  '42501', 'PS44 활성 상태로 새 상품 행 추가 거부');
select test.expect_error($$update core.product_catalog set activated_at = now() - interval '1 year' where product_key = 'internet_tv'$$,
  '42501', 'PS45 활성 시각 임의 변경 거부');

-- 정리: 시험으로 만든 CCTV 리드는 가상 데이터 정리 함수로 파기
select core.purge_customer_internal(l.id, null, 'test cleanup') from core.leads l where l.idempotency_key = 'idem-scope-00000013';
select test.expect_eq($$select string_agg(product_key, ',' order by product_key) from core.product_catalog where status = 'active'$$,
  'internet_tv', 'PS46 시험 종료 후 활성 상품은 다시 인터넷+TV 하나');
