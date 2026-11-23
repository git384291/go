-- 0026 접수 정책 규칙 확정(PM 11/24 결정). 0025는 수정하지 않고 게이트 함수를 교체한다.
-- api.policy_intake_gate(공급자, 통신사, 상품): 접수 트랜잭션 안에서 api.create_lead보다 먼저 부른다(서버가 서버 설정 상품 키로 호출).
--   1) 정책 상태 공유 잠금(트랜잭션 끝까지, 0025 트리거의 배타 잠금과 짝) — 정책 변경과 접수 동시 요청을 직렬화
--   2) 키 형식 오류            → POLICY_NOT_PUBLISHED
--   3) 게시 스위치 OFF         → POLICY_PUBLISH_OFF
--   4) 유효 승인 버전 중복     → POLICY_UNVERIFIED (유일 인덱스가 1차 방어)
--   5) 이 키의 유효 승인·게시 정책 0개(정책 없음·만료·미승인·상품 비활성) → POLICY_NOT_PUBLISHED
-- 조건은 api.policy_published()(0008)와 같다(승인·확인 시각·유효 기간·상품 활성, DB now()). 읽기만 하고 아무것도 바꾸지 않는다.
-- 의존: 0002(core.feature_flags), 0004(core.product_catalog), 0008(core.policy_versions), 0025(잠금 트리거). 0009(api.policy_list)는 쓰지 않는다.
begin;

drop function if exists api.policy_intake_gate();

create or replace function api.policy_intake_gate(p_supplier text, p_carrier text, p_product text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(7302251124);
  if p_supplier is null or p_carrier is null or p_product is null
     or p_supplier !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or p_carrier !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or p_product !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'POLICY_NOT_PUBLISHED' using errcode = '55000';
  end if;
  if not coalesce((select f.enabled from core.feature_flags f where f.key = 'policy_publish'), false) then
    raise exception 'POLICY_PUBLISH_OFF' using errcode = '55000';
  end if;
  if exists (
    select 1 from core.policy_versions v
     where v.state = 'approved' and v.valid_from <= now() and v.valid_until > now()
     group by v.policy_key having count(*) > 1
  ) then
    raise exception 'POLICY_UNVERIFIED' using errcode = '55000';
  end if;
  select count(*) into v_n
    from core.policy_versions v
    join core.product_catalog c on c.product_key = v.category and c.status = 'active'
   where v.supplier_id = p_supplier and v.segment = 'household' and v.carrier = p_carrier and v.product_id = p_product
     and v.state = 'approved' and v.confirmed_at <= now() and v.valid_from <= now() and v.valid_until > now();
  if v_n = 0 then
    raise exception 'POLICY_NOT_PUBLISHED' using errcode = '55000';
  elsif v_n > 1 then
    raise exception 'POLICY_UNVERIFIED' using errcode = '55000';
  end if;
end
$$;

revoke all on function api.policy_intake_gate(text, text, text) from public;

commit;
