-- 정책 검증 장애(B) 접수 게이트(0025, PM 11/24 추가 지시). 게시 스위치는 바꾸지 않는다(같은 값으로 쓰기만 해서 잠금을 확인한다).
\set ON_ERROR_STOP 1
reset role;
select enabled::text as pub0 from core.feature_flags where key = 'policy_publish' \gset
set role app_public;
select test.expect_ok($$select api.policy_intake_gate()$$, 'PG1 공개 역할 호출 가능, 충돌 없는 상태는 통과');
reset role;
-- 접수 게이트의 공유 잠금은 트랜잭션 끝까지 유지된다
begin;
select api.policy_intake_gate();
select test.expect_eq($$select (count(*) > 0)::text from pg_catalog.pg_locks where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid() and mode = 'ShareLock' and granted$$, 'true', 'PG2 게이트 뒤 정책 상태 공유 잠금 유지(트랜잭션 끝까지)');
rollback;
-- 정책 상태 쓰기(게시 스위치·정책 버전)는 배타 잠금을 잡는다
begin;
update core.feature_flags set enabled = enabled where key = 'policy_publish';
select test.expect_eq($$select (count(*) > 0)::text from pg_catalog.pg_locks where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid() and mode = 'ExclusiveLock' and granted$$, 'true', 'PG3 게시 스위치 쓰기는 정책 상태 배타 잠금');
rollback;
select test.expect_eq($$select count(*)::text from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
  where t.tgname in ('policy_versions_state_lock', 'feature_flags_state_lock') and t.tgenabled = 'O'$$, '2', 'PG4 정책 버전·게시 스위치 잠금 트리거 2개 활성');
-- 시험 DB의 앞선 시험(96)이 스위치를 켜 둘 수 있다: 이 시험이 값을 바꾸지 않았는지만 본다(운영 DB에는 이 시험을 돌리지 않는다)
select test.expect_eq($$select enabled::text from core.feature_flags where key = 'policy_publish'$$, :'pub0', 'PG5 이 시험은 게시 스위치 값을 바꾸지 않음');
