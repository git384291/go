-- 0006_release_probe.sql
-- FIDEON PM PHASE 1 최종 검수 보완(2항): 배포 전 점검이 '실제 차단 동작'을 운영 DB에서 읽기 전용으로 확인한다.
--
-- 배경
--   - 배포 전 점검 계정(release_auditor)은 테이블을 전혀 읽을 수 없다(V2). 그래서 기존 점검은 카탈로그(트리거·함수 본문·인덱스)만
--     보았고, 운영 DB에서 '지금 어떤 상품이 접수 가능한지'는 확인하지 못했다.
--   - 이 함수는 api.create_lead가 상품을 판정하는 것과 '같은 조건식'을 운영 데이터에 그대로 적용해 상품별 접수 허용 여부를 계산한다.
--
-- 안전 장치(운영 데이터 변경 불가)
--   - STABLE 함수: PostgreSQL은 STABLE 함수 안의 INSERT/UPDATE/DELETE를 실행 단계에서 거부한다
--     ("... is not allowed in a non-volatile function"). 쓰기 시도 코드가 들어갈 수 없다.
--   - 반환값은 위반 설명 문장뿐이다. 고객정보·승인자 ID·키는 반환하지 않는다.
--   - release_auditor에게는 이 함수 1개의 실행 권한과 api 스키마 USAGE만 준다. 테이블 권한은 계속 0이다(V2).
--   - 점검 SQL(db/audit/catalog_audit.sql)은 이 함수 본문의 해시도 검수본과 대조한다(V13). 바뀌면 배포 차단.
begin;

create or replace function api.release_probe_product_scope()
returns setof text
language plpgsql stable security definer set search_path = '' as $$
declare
  -- PHASE 1 기준값. src/content/catalog.ts · 0004 기준값과 같다(tests/unit/release-probe.test.ts가 대조)
  expected_keys   constant text[] := array['cctv_security', 'internet_only', 'internet_phone', 'internet_tv', 'mobile', 'other'];
  expected_active constant text[] := array['internet_tv'];
  k text;
  v_allowed boolean;
  v_keys text[];
begin
  -- P1 상품별 접수 허용 여부: api.create_lead '1-1)'과 같은 조건식
  foreach k in array expected_keys loop
    v_allowed := exists (select 1 from core.product_catalog pc where pc.product_key = k and pc.status = 'active');
    if v_allowed and not (k = any (expected_active)) then
      return next 'P1 lead accepted for reserved product: ' || k;
    elsif not v_allowed and k = any (expected_active) then
      return next 'P1 lead blocked for active product: ' || k;
    end if;
  end loop;

  -- P2 상품 목록이 기준과 같음(행 삭제·추가·동판 등 미승인 상품 추가 감지)
  select array_agg(pc.product_key order by pc.product_key collate "C") into v_keys from core.product_catalog pc;
  if v_keys is distinct from expected_keys then
    return next 'P2 product keys differ from baseline: ' || coalesce(array_to_string(v_keys, ','), '(none)');
  end if;

  -- P3 상태와 활성 시각 일치(제약이 있어도 데이터로 다시 확인)
  return query
    select 'P3 status/activated_at inconsistent: ' || pc.product_key
    from core.product_catalog pc
    where (pc.status = 'active') <> (pc.activated_at is not null);

  -- P4 PHASE 1에서는 진행 중인 활성화 승인이 없어야 한다(누군가 예약 상품 활성화를 준비 중이면 배포 전에 드러남)
  return query
    select 'P4 pending activation approval: ' || a.product_key || ' (' || a.approval_kind || ')'
    from core.product_activation_approvals a
    where a.consumed_at is null and a.created_at > now() - interval '7 days'
    order by 1;
end
$$;

revoke all on function api.release_probe_product_scope() from public;
grant usage on schema api to release_auditor;
grant execute on function api.release_probe_product_scope() to release_auditor;

commit;
