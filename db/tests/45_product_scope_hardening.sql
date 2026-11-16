-- PHASE 1 보완(검수 지적 1항): 승인 서명 재사용 방지
-- 가상 데이터만 사용. 예약 상품을 활성화하지 않고 검증한다(소진은 허용된 '소진 표시'로 만든다).
\set ON_ERROR_STOP 1
\set OWNER '''00000000-0000-4000-8000-000000000001''::uuid, ''10000000-0000-4000-8000-000000000001''::uuid'
\set PM    '''00000000-0000-4000-8000-000000000005''::uuid, ''10000000-0000-4000-8000-000000000005''::uuid'

-- 같은 서명을 여러 번 쓰는 시험을 위해 서명을 한 번만 만들어 둔다
-- 기준 시각을 한 번만 고정하고 서명 만료값을 결정적으로 정한다(초 경계와 무관, PM 6918873159)
select floor(extract(epoch from now()))::bigint as ph_base \gset
select set_config('t.h_owner', test.token_at('staff', array['product-approve', '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001', 'internet_phone', 'owner'], :ph_base + 110), false);
select set_config('t.h_pm', test.token_at('staff', array['product-approve', '00000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000005', 'internet_phone', 'pm'], :ph_base + 110), false);

select test.expect_ok(test.approval_sql(:OWNER, 'internet_phone', 'owner', p_proof => current_setting('t.h_owner')),
  'PH1 사용자 승인 기록(서명 A)');
select test.expect_error(test.approval_sql(:OWNER, 'internet_phone', 'owner', p_proof => current_setting('t.h_owner')),
  '42501', 'PH2 같은 서명 A 즉시 재사용 거부');
select test.expect_eq($$select (proof is null and proof_sha256 ~ '^[0-9a-f]{64}$')::text from core.product_activation_approvals
  where product_key = 'internet_phone' and approval_kind = 'owner'$$, 'true', 'PH3 서명 원문은 저장하지 않고 지문만 보관');
-- PH4: 서명 A와 다른 유효 서명(같은 기준, 만료값 +200)임을 먼저 입증한 뒤, 거부 사유가 '재사용'이 아니라 '미소진 대기 중복'임을 확인
select test.expect_eq(format($$select (test.token_at('staff', array['product-approve', '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001', 'internet_phone', 'owner'], %s) <> current_setting('t.h_owner'))::text$$, :ph_base + 200),
  'true', 'PH4a 새 서명은 서명 A와 다름(고정 기준, 초 경계와 무관)');
select test.expect_error_msg(test.approval_sql(:OWNER, 'internet_phone', 'owner', p_exp => :ph_base + 200),
  '42501', 'APPROVAL_ALREADY_PENDING', 'PH4 새 서명이라도 같은 칸에 미소진 승인이 있으면 거부(중복 대기 금지, 사유 확인)');
-- 대조: 같은 서명 A 재사용은 다른 사유(APPROVAL_PROOF_REUSED)로 거부된다
select test.expect_error_msg(test.approval_sql(:OWNER, 'internet_phone', 'owner', p_proof => current_setting('t.h_owner')),
  '42501', 'APPROVAL_PROOF_REUSED', 'PH4b 서명 A 재사용은 재사용 사유로 거부(PH4와 구분)');
select test.expect_error($$update core.product_activation_approvals set proof_sha256 = repeat('0', 64) where product_key = 'internet_phone'$$,
  '42501', 'PH5 지문 변경 거부(재사용 기록 지우기 불가)');

-- 재현 시나리오: 승인이 소진(무효화)된 뒤 같은 서명으로 다시 승인 → 0004에서는 통과했던 경로
select test.expect_ok($$update core.product_activation_approvals set consumed_at = now() where product_key = 'internet_phone'$$,
  'PH6 승인 소진 표시(무효화)');
select test.expect_error(test.approval_sql(:OWNER, 'internet_phone', 'owner', p_proof => current_setting('t.h_owner')),
  '42501', 'PH7 소진 뒤에도 같은 서명 A 재사용 거부(유효 시간 5분 안)');
select test.expect_ok(test.approval_sql(:PM, 'internet_phone', 'pm', p_proof => current_setting('t.h_pm')),
  'PH8 PM 승인 기록(서명 B)');
select test.expect_error($$update core.product_catalog set status = 'active' where product_key = 'internet_phone'$$,
  '42501', 'PH9 사용자 승인이 재사용으로 막혀 활성화 불가');
select test.expect_ok($$update core.product_activation_approvals set consumed_at = now()
  where product_key = 'internet_phone' and consumed_at is null$$, 'PH10 PM 승인 소진 표시');
select test.expect_error(test.approval_sql(:PM, 'internet_phone', 'pm', p_proof => current_setting('t.h_pm')),
  '42501', 'PH11 소진 뒤 같은 서명 B 재사용 거부');

select test.expect_eq($$select count(*)::text from core.product_activation_approvals where product_key = 'internet_phone'$$,
  '2', 'PH12 승인 행은 서명당 1건(A 1건, B 1건)');
select test.expect_eq($$select count(*)::text from pg_indexes where schemaname = 'core'
  and indexname in ('product_approvals_proof_once', 'product_approvals_one_open')$$, '2', 'PH13 최후 방어선 고유 인덱스 2개');
select test.expect_eq($$select status || '/' || (select count(*) from core.audit_logs where action = 'product.activate'
  and detail->>'product' = 'internet_phone') from core.product_catalog where product_key = 'internet_phone'$$,
  'reserved/0', 'PH14 집전화는 계속 예약, 활성화 기록 0건');
