-- 0025 롤백: 정책 상태 잠금 트리거·접수 게이트 함수 제거(데이터 변경 없음)
begin;
drop trigger if exists policy_versions_state_lock on core.policy_versions;
drop trigger if exists feature_flags_state_lock on core.feature_flags;
drop function if exists core.policy_state_lock();
drop function if exists api.policy_intake_gate();
commit;
