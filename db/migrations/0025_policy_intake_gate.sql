-- 0025 정책 검증 장애(B) 접수 차단 게이트(PM 11/24 추가 지시 1·2항).
-- - api.policy_intake_gate(): 접수 트랜잭션 안에서 api.create_lead보다 먼저 부른다.
--   1) 정책 상태 공유 잠금(트랜잭션 끝까지): 정책 버전·게시 스위치를 바꾸는 쓰기는 배타 잠금을 기다린다(아래 트리거).
--      → 접수 트랜잭션이 보는 정책 상태는 커밋까지 바뀌지 않는다(정책 변경과 접수 동시 요청 경합 차단).
--   2) 같은 정책 키에 지금 유효한 승인 버전이 둘 이상이면 POLICY_UNVERIFIED(55000)로 막는다(유일 인덱스가 1차 방어, 이것은 2차 방어).
-- - 서버(submitLead)는 같은 트랜잭션에서 api.policy_published()를 다시 읽어 견적 판정기로 장애 여부를 판정하고, 장애면 저장 전에 취소한다.
-- - 오류 코드만 내보낸다(문구·정책 내용·개인정보 없음). 게시 스위치는 읽기만 하고 바꾸지 않는다.
begin;

create or replace function api.policy_intake_gate()
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(7302251124);
  if exists (
    select 1 from core.policy_versions v
     where v.state = 'approved' and v.valid_from <= now() and v.valid_until > now()
     group by v.policy_key having count(*) > 1
  ) then
    raise exception 'POLICY_UNVERIFIED' using errcode = '55000';
  end if;
end
$$;

-- 정책 상태를 바꾸는 모든 쓰기(승인·대체·반려·초안, 게시 스위치)는 배타 잠금을 잡는다. 진행 중인 접수가 끝날 때까지 기다린다.
create or replace function core.policy_state_lock()
returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(7302251124);
  return null;
end
$$;

drop trigger if exists policy_versions_state_lock on core.policy_versions;
create trigger policy_versions_state_lock before insert or update or delete on core.policy_versions
  for each statement execute function core.policy_state_lock();
drop trigger if exists feature_flags_state_lock on core.feature_flags;
create trigger feature_flags_state_lock before insert or update or delete on core.feature_flags
  for each statement execute function core.policy_state_lock();

revoke all on function api.policy_intake_gate() from public;
revoke all on function core.policy_state_lock() from public;

commit;
