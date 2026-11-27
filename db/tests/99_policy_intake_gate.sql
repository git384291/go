-- 접수 정책 게이트(0025 잠금 트리거 + 0026 규칙, PM 11/24 결정). 순서 독립: 필요한 상태를 이 파일 안에서 만들고(트랜잭션) 끝에 모두 되돌린다.
-- 정책 행은 지울 수 없으므로(POLICY_IMMUTABLE) 정책 준비는 롤백되는 트랜잭션 안에서만 한다. 게시 스위치는 시작 값으로 복원·확인한다.
\set ON_ERROR_STOP 1
reset role;
select enabled::text as pub0 from core.feature_flags where key = 'policy_publish' \gset
select product_key as cat from core.product_catalog where status = 'active' order by product_key limit 1 \gset
begin;
update core.feature_flags set enabled = false where key = 'policy_publish';
set local role app_public;
select test.expect_error_msg($$select api.policy_intake_gate('pg-sup', 'pg-car', 'pg-ok')$$, '55000', 'POLICY_PUBLISH_OFF', 'PG1 [필수2] 게시 스위치 OFF → 접수 차단(공개 역할 호출)');
reset role;
update core.feature_flags set enabled = true where key = 'policy_publish';
set local role app_public;
select test.expect_error_msg($$select api.policy_intake_gate('pg-sup', 'pg-car', 'pg-ok')$$, '55000', 'POLICY_NOT_PUBLISHED', 'PG2 [필수1] 스위치 ON이어도 이 키의 게시 정책 없음 → 차단');
select test.expect_error_msg($$select api.policy_intake_gate('Bad Key', 'pg-car', 'pg-ok')$$, '55000', 'POLICY_NOT_PUBLISHED', 'PG2b 키 형식 오류 → 차단');
select test.expect_error_msg($$select api.policy_intake_gate(null, 'pg-car', 'pg-ok')$$, '55000', 'POLICY_NOT_PUBLISHED', 'PG2c 키 누락 → 차단');
reset role;
-- 만료된 승인 정책(pg-old), 아직 시작 전(pg-future), 제출만 된 정책(pg-sub), 유효 승인 정책(pg-ok)
insert into core.policy_versions (supplier_id, segment, carrier, product_id, category, revision, state, source_kind, confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by)
values ('pg-sup', 'household', 'pg-car', 'pg-old', :'cat', 1, 'approved', 'official_policy_sheet', now() - interval '3 day', now() - interval '3 day', now() - interval '1 day', '가상(만료)', '{"monthlyFee":{"known":false},"contractMonths":{"known":false},"equipmentMonthlyFee":{"known":false},"installFee":{"known":false},"bundlePrerequisites":{"known":false},"regionScope":{"known":false},"customerBenefit":{"known":false}}', repeat('a', 64), '00000000-0000-4000-8000-0000000000f1'),
       ('pg-sup', 'household', 'pg-car', 'pg-future', :'cat', 1, 'approved', 'official_policy_sheet', now() - interval '1 hour', now() + interval '1 day', now() + interval '2 day', '가상(시작 전)', '{"monthlyFee":{"known":false},"contractMonths":{"known":false},"equipmentMonthlyFee":{"known":false},"installFee":{"known":false},"bundlePrerequisites":{"known":false},"regionScope":{"known":false},"customerBenefit":{"known":false}}', repeat('b', 64), '00000000-0000-4000-8000-0000000000f1'),
       ('pg-sup', 'household', 'pg-car', 'pg-sub', :'cat', 1, 'submitted', 'official_policy_sheet', now() - interval '1 hour', now() - interval '1 hour', now() + interval '1 day', '가상(미승인)', '{"monthlyFee":{"known":false},"contractMonths":{"known":false},"equipmentMonthlyFee":{"known":false},"installFee":{"known":false},"bundlePrerequisites":{"known":false},"regionScope":{"known":false},"customerBenefit":{"known":false}}', repeat('c', 64), '00000000-0000-4000-8000-0000000000f1'),
       ('pg-sup', 'household', 'pg-car', 'pg-ok', :'cat', 1, 'approved', 'official_policy_sheet', now() - interval '1 hour', now() - interval '1 hour', now() + interval '1 day', '가상(유효)', '{"monthlyFee":{"known":false},"contractMonths":{"known":false},"equipmentMonthlyFee":{"known":false},"installFee":{"known":false},"bundlePrerequisites":{"known":false},"regionScope":{"known":false},"customerBenefit":{"known":false}}', repeat('d', 64), '00000000-0000-4000-8000-0000000000f1');
set local role app_public;
select test.expect_error_msg($$select api.policy_intake_gate('pg-sup', 'pg-car', 'pg-old')$$, '55000', 'POLICY_NOT_PUBLISHED', 'PG3 만료된 승인 정책 → 차단');
select test.expect_error_msg($$select api.policy_intake_gate('pg-sup', 'pg-car', 'pg-future')$$, '55000', 'POLICY_NOT_PUBLISHED', 'PG3b 시작 전 정책 → 차단');
select test.expect_error_msg($$select api.policy_intake_gate('pg-sup', 'pg-car', 'pg-sub')$$, '55000', 'POLICY_NOT_PUBLISHED', 'PG3c 미승인(제출) 정책 → 차단');
select test.expect_ok($$select api.policy_intake_gate('pg-sup', 'pg-car', 'pg-ok')$$, 'PG4 [필수3 DB] 스위치 ON + 유효 승인 정책 1개 → 통과');
select test.expect_error_msg($$select api.policy_intake_gate('pg-sup', 'pg-car', 'pg-other')$$, '55000', 'POLICY_NOT_PUBLISHED', 'PG4b 다른 키의 정책으로는 통과 못 함');
reset role;
select test.expect_eq($$select (count(*) > 0)::text from pg_catalog.pg_locks where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid() and mode = 'ShareLock' and granted$$, 'true', 'PG5 게이트의 정책 상태 공유 잠금은 트랜잭션 끝까지 유지');
rollback;
-- 정책 상태 쓰기는 배타 잠금
begin;
update core.feature_flags set enabled = enabled where key = 'policy_publish';
select test.expect_eq($$select (count(*) > 0)::text from pg_catalog.pg_locks where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid() and mode = 'ExclusiveLock' and granted$$, 'true', 'PG5b 게시 스위치 쓰기는 정책 상태 배타 잠금');
rollback;
select test.expect_eq($$select count(*)::text from pg_catalog.pg_trigger where tgname in ('policy_versions_state_lock', 'feature_flags_state_lock') and tgenabled = 'O'$$, '2', 'PG5c 잠금 트리거 2개 활성');
select test.expect_eq($$select count(*)::text from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname = 'policy_intake_gate'$$, '1', 'PG5d 게이트는 0026 규칙 1개만(0025 무인자 버전 제거)');
select test.expect_eq($$select count(*)::text from core.policy_versions where supplier_id = 'pg-sup'$$, '0', 'PG7 시험용 정책 행 남지 않음(롤백)');
select test.expect_eq($$select enabled::text from core.feature_flags where key = 'policy_publish'$$, :'pub0', 'PG8 [필수8] 게시 스위치 시작 값 복원');
