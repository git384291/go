-- 0019 롤백 뒤 복구: 0019_lead_amendments.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다(확인 후 직접 삭제).
\set ON_ERROR_STOP 1
begin;
insert into pii.lead_amendments (id, customer_id, lead_id, idempotency_key, payload_enc, summary, content_hmac, created_at)
  select a.id, a.customer_id, a.lead_id, a.idempotency_key, a.payload_enc, a.summary, a.content_hmac, a.created_at
    from pii.lead_amendments_rollback_archive a
   where exists (select 1 from pii.customers c where c.id = a.customer_id) on conflict do nothing;
commit;
