-- 0009_policy_list.sql — 관리자 정책 화면용 조회 함수 (PM 11/21). 쓰기 함수는 0008 그대로 쓴다.
-- 직원 서명·세션으로 owner·policy_editor·reviewer만 호출할 수 있다. 정책 내용(terms)과 상태만 돌려주고 수수료·원문 위치는 없다.
-- 롤백: db/rollback/0009_down.sql (함수 삭제뿐, 데이터 변경 없음)
begin;

create or replace function api.policy_list(p_actor uuid, p_session uuid, p_token text, p_limit int, p_offset int)
returns table (
  id uuid, supplier_id text, segment text, carrier text, product_id text, category text, revision int, state text,
  source_kind text, product_label text, confirmed_at timestamptz, valid_from timestamptz, valid_until timestamptz,
  content_hash text, created_by uuid, self_approval boolean, created_at timestamptz, decided_at timestamptz,
  decision_reason text, terms jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform security.assert_staff(p_actor, p_session, p_token, array['owner', 'policy_editor', 'reviewer']);
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  return query
  select v.id, v.supplier_id, v.segment, v.carrier, v.product_id, v.category, v.revision, v.state,
         v.source_kind, v.product_label, v.confirmed_at, v.valid_from, v.valid_until,
         v.content_hash, v.created_by, v.self_approval, v.created_at, v.decided_at,
         v.decision_reason, v.terms
  from core.policy_versions v
  order by v.created_at desc, v.id
  limit p_limit offset p_offset;
end
$$;

commit;
