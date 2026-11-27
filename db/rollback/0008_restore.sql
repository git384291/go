-- 0008 롤백 뒤 복구: 0008_policy_store.sql을 다시 적용한 다음 실행한다. 보관 테이블은 지우지 않는다.
\set ON_ERROR_STOP 1
begin;
-- 승인본이 둘 이상이면 부분 유니크 인덱스가 막는다. 같은 상태·시각·해시 그대로 되돌린다(내용 변경 없음).
insert into core.policy_versions (id, supplier_id, segment, carrier, product_id, category, revision, state, source_kind,
    confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by, created_at, submitted_at,
    decided_by, decided_at, decision_reason, self_approval, checks, superseded_at)
  select a.id, a.supplier_id, a.segment, a.carrier, a.product_id, a.category, a.revision, a.state, a.source_kind,
    a.confirmed_at, a.valid_from, a.valid_until, a.product_label, a.terms, a.content_hash, a.created_by, a.created_at, a.submitted_at,
    a.decided_by, a.decided_at, a.decision_reason, a.self_approval, a.checks, a.superseded_at
  from core.policy_versions_rollback_archive a
  on conflict (id) do nothing;
select (select count(*) from core.policy_versions_rollback_archive) as archived, (select count(*) from core.policy_versions) as restored_total;
commit;
