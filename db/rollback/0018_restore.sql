-- 0018 롤백 뒤 복구: 0018_ad_launches.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다(확인 후 직접 삭제).
\set ON_ERROR_STOP 1
begin;
insert into core.ad_launches (id, campaign_key, request_key, amount_krw, state, external_id, note, created_by, created_at, updated_at)
  select a.id, a.campaign_key, a.request_key, a.amount_krw, a.state, a.external_id, a.note, a.created_by, a.created_at, a.updated_at
    from core.ad_launches_rollback_archive a on conflict do nothing;
commit;
