-- 접수 직전 고지 승인 게이트(0016). 전용 버전 'gate-v1'(가상 문구)을 쓰고, 끝에서 접수 문서 버전 설정을 원래 값으로 되돌린다.
\set ON_ERROR_STOP 1
reset role;
select value #>> '{}' as pv0 from core.settings where key = 'privacy_policy_version' \gset
insert into core.notice_texts (version, notice_key, body, body_sha256) values ('gate-v1', 'gate_a', '게이트 가상 문구 A', repeat('0', 64)), ('gate-v1', 'gate_b', '게이트 가상 문구 B', repeat('0', 64));
update core.settings set value = '"gate-v1"'::jsonb where key = 'privacy_policy_version';
select (select jsonb_object_agg(notice_key, body_sha256) from core.notice_texts where version = 'gate-v1')::text as h \gset
select (select jsonb_object_agg(notice_key, body_sha256) from core.notice_texts where version = 'gate-v1' and notice_key = 'gate_a')::text as h_one \gset
select (select jsonb_object_agg(notice_key, case when notice_key = 'gate_b' then repeat('f', 64) else body_sha256 end) from core.notice_texts where version = 'gate-v1')::text as h_bad \gset
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h'), '55000', 'NOTICE_NOT_APPROVED', 'Z1 검수 기록이 없으면 접수 차단');
select test.expect_error_msg(format($$select api.notice_intake_gate(null, %L::jsonb)$$, :'h'), '55000', 'NOTICE_INVALID', 'Z2 입력 형식 오류');
select test.expect_error_msg($$select api.notice_intake_gate('gate-v1', '{}'::jsonb)$$, '55000', 'NOTICE_INVALID', 'Z2b 빈 해시 목록');
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v0', %L::jsonb)$$, :'h'), '55000', 'NOTICE_VERSION_MISMATCH', 'Z3 접수 문서 버전이 설정과 다르면 차단');
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h_one'), '55000', 'NOTICE_KEYS_MISMATCH', 'Z4 항목 키 집합이 다르면 차단(서버 상수에 항목 누락)');
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h_bad'), '55000', 'NOTICE_HASH_MISMATCH', 'Z5 서버 상수 문구 해시가 DB와 다르면 차단');
-- 승인(작성자와 다른 검토자) → 통과
insert into core.notice_reviews (version, decision, checks, texts_sha256, reason, reviewer_id)
select 'gate-v1', 'approved', '{}'::jsonb, encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex'), '게이트 시험 승인', '00000000-0000-4000-8000-0000000000e1'
from core.notice_texts n where n.version = 'gate-v1';
set role app_public;
select test.expect_ok(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h'), 'Z6 승인·해시·버전이 모두 맞으면 통과(공개 역할 호출 가능)');
reset role;
-- 승인 취소(이후 반려 기록) → 즉시 차단, 다시 승인 → 통과
select pg_sleep(0.01);
insert into core.notice_reviews (version, decision, checks, texts_sha256, reason, reviewer_id)
values ('gate-v1', 'rejected', '{}'::jsonb, repeat('a', 64), '승인 취소 시험', '00000000-0000-4000-8000-0000000000e1');
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h'), '55000', 'NOTICE_NOT_APPROVED', 'Z7 승인 취소(이후 반려) 시 즉시 차단');
select pg_sleep(0.01);
insert into core.notice_reviews (version, decision, checks, texts_sha256, reason, reviewer_id)
select 'gate-v1', 'approved', '{}'::jsonb, encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex'), '재승인', '00000000-0000-4000-8000-0000000000e1'
from core.notice_texts n where n.version = 'gate-v1';
select test.expect_ok(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h'), 'Z8 재승인하면 다시 통과');
-- 승인자가 문구 작성자인 기록(함수를 우회해 직접 삽입한 경우)은 차단
insert into core.audit_logs (actor_id, action, target_type, target_id, reason, detail)
values ('00000000-0000-4000-8000-0000000000e1', 'notice.text_add', 'notice_text', null, '작성자 기록 시험', '{"version":"gate-v1","key":"gate_a","sha256":"x"}'::jsonb);
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h'), '55000', 'NOTICE_SELF_APPROVED', 'Z9 작성자와 승인자가 같으면 차단(직접 삽입 우회 방어)');
-- 승인 이후 문구가 추가되면 이전 승인은 무효: 새 키까지 해시를 맞춰도 승인 시점 묶음과 달라 차단
insert into core.notice_texts (version, notice_key, body, body_sha256) values ('gate-v1', 'gate_c', '게이트 가상 문구 C', repeat('0', 64));
select (select jsonb_object_agg(notice_key, body_sha256) from core.notice_texts where version = 'gate-v1')::text as h3 \gset
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h3'), '55000', 'NOTICE_CHANGED', 'Z10 승인 뒤 문구가 추가되면 즉시 차단(NOTICE_CHANGED)');
select test.expect_error_msg(format($$select api.notice_intake_gate('gate-v1', %L::jsonb)$$, :'h'), '55000', 'NOTICE_KEYS_MISMATCH', 'Z10b 서버 상수가 옛 항목 그대로면 키 불일치로도 차단');
select test.expect_eq($$select count(*)::text from core.leads where idempotency_key like 'gate-%'$$, '0', 'Z11 게이트는 어떤 데이터도 만들지 않음');
update core.settings set value = to_jsonb(:'pv0'::text) where key = 'privacy_policy_version';
select test.expect_eq($$select value #>> '{}' from core.settings where key = 'privacy_policy_version'$$, :'pv0', 'Z12 접수 문서 버전 설정 원복');
