-- 시험 전용(폐기 DB): 계정 합산 광고 한도(0020·0036) 시험 격리를 위해 광고 원장·경고·launch·보고 비용을 비운다. 운영 DB에서 실행하지 않는다.
\set ON_ERROR_STOP 1
do $$ begin
  if current_database() not like '%test%' then raise exception 'reset_ad_account: 시험 DB가 아님'; end if;
end $$;
set session_replication_role = replica;  -- 원장·경고 보호 트리거를 이 세션에서만 건너뜀(슈퍼유저, 폐기 DB)
delete from core.ad_exposure;
delete from core.ad_monitor_runs;
delete from core.ad_monitor_leases;
delete from core.ad_spend_ledger;
delete from core.ad_alerts;
delete from core.ad_launches;
delete from core.ad_performance;  -- 0036: 월 사용액(보고 비용 포함)이 계정 월 3만 판정에 들어가므로 함께 비운다
set session_replication_role = origin;
