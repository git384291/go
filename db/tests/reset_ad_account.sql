-- 시험 전용(폐기 DB): 계정 합산 광고 한도(0020) 시험 격리를 위해 광고 원장·경고·launch를 비운다. 운영 DB에서 실행하지 않는다.
\set ON_ERROR_STOP 1
do $$ begin
  if current_database() not like '%test%' then raise exception 'reset_ad_account: 시험 DB가 아님'; end if;
end $$;
set session_replication_role = replica;  -- 원장·경고 보호 트리거를 이 세션에서만 건너뜀(슈퍼유저, 폐기 DB)
delete from core.ad_spend_ledger;
delete from core.ad_alerts;
delete from core.ad_launches;
set session_replication_role = origin;
