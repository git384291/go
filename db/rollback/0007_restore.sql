-- 0007 롤백 뒤 복구: 0007_required_notices.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다(확인 후 직접 삭제).
\set ON_ERROR_STOP 1
begin;
insert into core.notice_texts (version, notice_key, body)
  select a.version, a.notice_key, a.body from core.notice_texts_rollback_archive a
  on conflict (version, notice_key) do nothing;
-- 해시는 DB가 다시 계산한다. 보관본과 다르면 복구를 중단한다(문구 변조 방지).
do $$
begin
  if exists (select 1 from core.notice_texts_rollback_archive a join core.notice_texts n
             on n.version = a.version and n.notice_key = a.notice_key where n.body_sha256 <> a.body_sha256) then
    raise exception 'NOTICE_HASH_MISMATCH' using errcode = '22023';
  end if;
end $$;
insert into pii.notice_exposures (id, customer_id, doc_version, notice_key, body_sha256, channel, shown_at)
  select a.id, a.customer_id, a.doc_version, a.notice_key, a.body_sha256, a.channel, a.shown_at
  from pii.notice_exposures_rollback_archive a
  where exists (select 1 from pii.customers c where c.id = a.customer_id)
  on conflict (id) do nothing;
select (select count(*) from pii.notice_exposures_rollback_archive) as archived,
       (select count(*) from pii.notice_exposures) as restored_total;
commit;
