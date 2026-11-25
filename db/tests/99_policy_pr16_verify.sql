-- PR #16 추가 검증(PM 11/25): 비활성 상품 노출 차단 · 요금/사은품/설치비/고지 정확성 · 캐시 구조 · 트랜잭션 실패 롤백 ·
-- Supabase 공식 문서(RLS·SECURITY DEFINER·Data API 보안) 기준 구조 점검. 가상 데이터만 사용한다.
-- 기존 60·96·98·99_policy_intake_gate와 PS1~PS17을 반복하지 않는다. 전체를 한 트랜잭션으로 실행하고 마지막에 되돌려 다른 시험에 영향이 없다.
-- 실제 Supabase 프로젝트가 아니라 로컬 가상 DB(PostgreSQL)에서 도는 시험이다. 호스팅 Supabase 고유 설정(Data API 노출 스키마·anon/authenticated 권한 등)은 이 파일로 검증하지 않는다.
\set ON_ERROR_STOP 1
reset role;
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 준비: 시험 전용 정책 담당자(시드 사용자와 겹치지 않는 값), 호출 문장 생성 함수, 롤백 확인용 상태 요약·실패 주입
-- ---------------------------------------------------------------------------------------------------------------------
insert into core.staff (user_id, role, active) values ('00000000-0000-4000-8000-000000000016', 'policy_editor', true);
insert into security.staff_sessions (id, user_id, created_at, revoked_at) values
  ('10000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-000000000016', now(), null);
update core.feature_flags set enabled = true where key = 'policy_publish';   -- 이 트랜잭션 안에서만 ON(마지막에 되돌림)

create function test.v16_terms(p_fee int, p_vat text, p_equip int, p_equip_vat text, p_install text, p_gift int) returns jsonb language sql as $$
  select jsonb_build_object(
    'monthlyFee', jsonb_build_object('known', true, 'value', jsonb_build_object('amountKrw', p_fee, 'vat', p_vat)),
    'contractMonths', jsonb_build_object('known', true, 'value', 36),
    'equipmentMonthlyFee', jsonb_build_object('known', true, 'value', jsonb_build_object('amountKrw', p_equip, 'vat', p_equip_vat)),
    'installFee', case when p_install is null then jsonb_build_object('known', false)
                       else jsonb_build_object('known', true, 'value', jsonb_build_object('amountKrw', p_install::int, 'vat', 'included')) end,
    'bundlePrerequisites', jsonb_build_object('known', true, 'value', '[]'::jsonb),
    'regionScope', jsonb_build_object('known', true, 'value', 'nationwide'),
    'customerBenefit', jsonb_build_object('known', true, 'value', jsonb_build_object('amountKrw', p_gift, 'form', 'gift_card',
      'payoutCondition', jsonb_build_object('known', true, 'value', '개통 완료 후 지급'),
      'cancellationCondition', jsonb_build_object('known', true, 'value', '약정 내 해지 시 환수'))))
$$;

-- p_who: owner | editor
create function test.v16_draft(p_who text, p_product text, p_category text, p_terms jsonb) returns text
language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' else '00000000-0000-4000-8000-000000000016' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' else '10000000-0000-4000-8000-000000000016' end;
begin
  return format('select api.policy_create_draft(%L, %L, %L, ''supplier-v16'', ''household'', ''carrier-x'', %L, %L, ''official_policy_sheet'', now() - interval ''1 hour'', now() - interval ''1 hour'', now() + interval ''1 day'', ''검증용 가상 상품'', %L::jsonb)',
                a, s, test.staff_token(a, s), p_product, p_category, p_terms::text);
end $$;
create function test.v16_call(p_who text, p_fn text, p_id text, p_extra text default '') returns text
language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' else '00000000-0000-4000-8000-000000000016' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' else '10000000-0000-4000-8000-000000000016' end;
begin
  return format('select api.%s(%L, %L, %L, %L%s)', p_fn, a, s, test.staff_token(a, s), p_id, p_extra);
end $$;
create function test.v16_checks() returns text language sql as $$
  select ', ''확인 완료''::text, ''{"source_matched":true,"validity":true,"vat":true,"benefit_terms":true,"region_bundle":true}''::jsonb' $$;
create function test.v16_pub_set(p_enabled boolean) returns text
language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := '00000000-0000-4000-8000-000000000001';
  s uuid := '10000000-0000-4000-8000-000000000001';
begin
  return format('select api.policy_publish_set(%L, %L, %L, %s, ''시험'')', a, s, test.staff_token(a, s), p_enabled::text);
end $$;
create function test.v16_id(p_product text, p_rev int) returns text language sql security definer set search_path = pg_catalog as $$
  select id::text from core.policy_versions where product_id = p_product and revision = p_rev $$;
-- 초안 → 제출 → 승인까지(준비 단계. 권한 검증이 목적이 아니므로 현재 역할로 실행)
create function test.v16_publish(p_product text, p_terms jsonb) returns text language plpgsql as $$
declare v_id uuid;
begin
  execute test.v16_draft('editor', p_product, 'internet_tv', p_terms) into v_id;
  execute test.v16_call('editor', 'policy_submit', v_id::text);
  execute test.v16_call('owner', 'policy_approve', v_id::text, test.v16_checks());
  return v_id::text;
end $$;
-- 정책·감사·게시 스위치 상태를 한 줄로 요약(실패 전후 비교용)
create function test.v16_snap() returns text language sql security definer set search_path = pg_catalog as $$
  select (select count(*) from core.policy_versions) || '/' || (select count(*) from core.audit_logs) || '/'
      || coalesce((select string_agg(state, ',' order by revision) from core.policy_versions where product_id = 'vd1'), '-') || '/'
      || (select enabled::text from core.feature_flags where key = 'policy_publish') $$;
-- 감사 기록 저장 직전에 지정한 동작이면 실패시키는 시험 전용 트리거(이 트랜잭션 안에서만 존재)
create function test.v16_inject() returns trigger language plpgsql as $$
begin
  if new.action = current_setting('test.v16_fail_action', true) then
    raise exception 'INJECTED_ERROR' using errcode = 'XX999';
  end if;
  return new;
end $$;
create trigger v16_inject before insert on core.audit_logs for each row execute function test.v16_inject();

-- ---------------------------------------------------------------------------------------------------------------------
-- A. 비활성 상품 노출 차단
-- ---------------------------------------------------------------------------------------------------------------------
set role app_staff;
select test.expect_error(test.v16_draft('owner', 'va1', c, test.v16_terms(27700, 'included', 2200, 'excluded', '33000', 5500)), 'FP001',
                         format('V16-A1 비활성·미등록 상품(%s) 정책 초안 불가', c))
  from unnest(array['internet_phone', 'internet_only', 'cctv_security', 'other', 'mobile', 'tv_only', '']) c;
select test.expect_error(test.v16_draft('editor', 'va1', 'mobile', test.v16_terms(27700, 'included', 2200, 'excluded', '33000', 5500)), 'FP001', 'V16-A1b 정책 담당자(editor)도 비활성 상품 불가');
-- 앱 역할이 정책 테이블에 직접 쓰기(API 우회) 시도
select test.expect_error(format($i$insert into core.policy_versions (supplier_id, segment, carrier, product_id, category, revision, state, source_kind, confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by)
  values ('supplier-v16', 'household', 'carrier-x', 'va2', 'mobile', 1, 'approved', 'official_policy_sheet', now(), now(), now() + interval '1 day', 'x', %L::jsonb, repeat('a', 64), gen_random_uuid())$i$,
  test.v16_terms(1, 'included', 0, 'included', '0', 0)::text), '42501', 'V16-A2 app_staff는 정책 테이블에 직접 INSERT 불가');
reset role;
set role app_public;
select test.expect_error(format($i$insert into core.policy_versions (supplier_id, segment, carrier, product_id, category, revision, state, source_kind, confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by)
  values ('supplier-v16', 'household', 'carrier-x', 'va2', 'internet_tv', 1, 'approved', 'official_policy_sheet', now(), now(), now() + interval '1 day', 'x', %L::jsonb, repeat('a', 64), gen_random_uuid())$i$,
  test.v16_terms(1, 'included', 0, 'included', '0', 0)::text), '42501', 'V16-A2b app_public(고객 역할)도 정책 테이블에 직접 INSERT 불가');
select test.expect_error($$select * from core.policy_versions$$, '42501', 'V16-A2c app_public은 정책 테이블 직접 조회 불가(승인 전 정책 원문 노출 차단)');
select test.expect_error($$update core.feature_flags set enabled = true where key = 'policy_publish'$$, '42501', 'V16-A2d app_public은 게시 스위치 직접 변경 불가');
reset role;

-- 다층 방어: 비활성 상품의 '승인' 행이 어떤 경로로든 생겼어도(관리자 연결로 직접 삽입) 고객 게시에는 나가지 않는다. 활성 상품 대조 행은 나간다.
insert into core.policy_versions (supplier_id, segment, carrier, product_id, category, revision, state, source_kind, confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by)
select 'supplier-v16', 'household', 'carrier-x', pid, cat, 1, 'approved', 'official_policy_sheet', now() - interval '1 hour', now() - interval '1 hour', now() + interval '1 day', '직접 삽입 시험',
       test.v16_terms(27700, 'included', 2200, 'excluded', '33000', 5500), repeat('b', 64), gen_random_uuid()
  from (values ('va3-mobile', 'mobile'), ('va3-phone', 'internet_phone'), ('va3-active', 'internet_tv')) t(pid, cat);
set role app_public;
select test.expect_eq($$select count(*)::text from api.policy_published() p where p ->> 'productId' in ('va3-mobile', 'va3-phone')$$, '0', 'V16-A3 승인·유효해도 비활성 상품(휴대폰·집전화) 정책은 게시 0건');
select test.expect_eq($$select count(*)::text from api.policy_published() p where p ->> 'productId' = 'va3-active'$$, '1', 'V16-A3b 대조: 같은 조건의 활성 상품(인터넷+TV) 정책은 게시 1건');
reset role;

-- 상품을 비활성으로 돌리면 이미 승인된 정책도 즉시 게시에서 빠지고, 다시 켜려면 사용자·PM 2인 승인이 있어야 한다(관리자 연결도 불가)
savepoint a4;
update core.product_catalog set status = 'reserved' where product_key = 'internet_tv';
set role app_public;
select test.expect_eq($$select count(*)::text from api.policy_published() p where p ->> 'productId' = 'va3-active'$$, '0', 'V16-A4 상품 비활성화 즉시 해당 정책 게시 0건');
reset role;
set role app_staff;
select test.expect_error(test.v16_draft('owner', 'va4', 'internet_tv', test.v16_terms(27700, 'included', 2200, 'excluded', '33000', 5500)), 'FP001', 'V16-A4b 비활성화된 상품은 새 초안도 불가');
reset role;
select test.expect_error_msg($$update core.product_catalog set status = 'active', activated_at = now() where product_key = 'internet_tv'$$, '42501', 'PRODUCT_ACTIVATION_REQUIRES_APPROVAL', 'V16-A4c 2인 승인 없이는 관리자 연결로도 재활성화 불가');
rollback to savepoint a4;
select test.expect_error_msg($$update core.product_catalog set status = 'active', activated_at = now() where product_key = 'mobile'$$, '42501', 'PRODUCT_ACTIVATION_REQUIRES_APPROVAL', 'V16-A5 예약 상품(휴대폰) 직접 활성화 불가');
select test.expect_eq($$select string_agg(product_key, ',' order by product_key) from core.product_catalog where status = 'active'$$, 'internet_tv', 'V16-A5b 활성 상품은 인터넷+TV 하나뿐(되돌린 뒤 확인)');

-- ---------------------------------------------------------------------------------------------------------------------
-- B. 요금·사은품·설치비·필수 고지 정확성
-- ---------------------------------------------------------------------------------------------------------------------
select test.v16_publish('vb1', test.v16_terms(27700, 'included', 2200, 'excluded', '33000', 5500));
set role app_public;
select set_config('t.v16_pub', (select p::text from api.policy_published() p where p ->> 'productId' = 'vb1'), false);
reset role;
select test.expect_eq($$select count(*)::text from unnest(array['monthlyFee', 'contractMonths', 'equipmentMonthlyFee', 'installFee', 'bundlePrerequisites', 'regionScope', 'customerBenefit']) k,
  core.policy_versions v where v.product_id = 'vb1' and (current_setting('t.v16_pub')::jsonb -> k) is distinct from (v.terms -> k)$$, '0', 'V16-B1 게시된 7개 조건이 승인 원본 값과 키마다 완전히 같음(요금·약정·장비·설치비·결합·지역·사은품)');
select test.expect_eq($$select (j #>> '{monthlyFee,value,amountKrw}') || '|' || (j #>> '{monthlyFee,value,vat}') || '|' || (j #>> '{equipmentMonthlyFee,value,amountKrw}') || '|' || (j #>> '{equipmentMonthlyFee,value,vat}')
  || '|' || (j #>> '{installFee,value,amountKrw}') || '|' || (j #>> '{installFee,value,vat}') || '|' || (j #>> '{contractMonths,value}')
  || '|' || (j #>> '{customerBenefit,value,amountKrw}') || '|' || (j #>> '{customerBenefit,value,form}')
  from (select current_setting('t.v16_pub')::jsonb j) s$$, '27700|included|2200|excluded|33000|included|36|5500|gift_card', 'V16-B2 월요금 27,700(VAT 포함)·장비 2,200(VAT 별도)·설치비 33,000·약정 36개월·사은품 5,500 상품권');
select test.expect_eq($$select (j #>> '{customerBenefit,value,payoutCondition,value}') || '|' || (j #>> '{customerBenefit,value,cancellationCondition,value}') from (select current_setting('t.v16_pub')::jsonb j) s$$,
  '개통 완료 후 지급|약정 내 해지 시 환수', 'V16-B3 사은품 지급·환수 조건 문구가 승인 원본과 같음');
select test.expect_eq($$select (j ->> 'version') || '|' || (j ->> 'category') || '|' || (j ->> 'productLabel') || '|' || (j ->> 'reviewStatus') || '|' || (j ->> 'sourceKind') from (select current_setting('t.v16_pub')::jsonb j) s$$,
  'r1|internet_tv|검증용 가상 상품|approved|official_policy_sheet', 'V16-B4 게시 버전·상품·검수 상태·출처가 승인 원본과 같음');
select test.expect_eq($$select bool_and((j ->> k) ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$')::text from (select current_setting('t.v16_pub')::jsonb j) s, unnest(array['confirmedAt', 'validFrom']) k$$, 'true', 'V16-B5 시각은 +09:00(한국 시간) 형식');
select test.expect_eq($$select ((j ->> 'confirmedAt')::timestamptz = date_trunc('second', v.confirmed_at))::text || ',' || ((j ->> 'validFrom')::timestamptz = date_trunc('second', v.valid_from))::text
  || ',' || ((j #>> '{validUntil,value}')::timestamptz = date_trunc('second', v.valid_until))::text
  from (select current_setting('t.v16_pub')::jsonb j) s, core.policy_versions v where v.product_id = 'vb1'$$, 'true,true,true', 'V16-B6 게시 시각을 되읽으면 저장된 확인·시작·만료 시각과 같음(시간대 변환 오류 없음)');
select test.expect_eq($$select string_agg(k, ',' order by k) from (select current_setting('t.v16_pub')::jsonb j) s, jsonb_object_keys(j) k$$,
  'bundlePrerequisites,carrier,category,confirmedAt,contractMonths,customerBenefit,equipmentMonthlyFee,installFee,monthlyFee,productId,productLabel,regionScope,reviewStatus,segment,sourceKind,supplierId,validFrom,validUntil,version',
  'V16-B7 게시 필드는 허용 목록 19개뿐(수수료·원문 위치·작성자·승인자 없음)');
select test.expect_eq($$select (encode(sha256(convert_to(concat_ws('|', v.policy_key, v.category, v.source_kind, v.confirmed_at::text, v.valid_from::text, coalesce(v.valid_until::text, ''), v.product_label, v.terms::text), 'UTF8')), 'hex') = v.content_hash)::text
  from core.policy_versions v where v.product_id = 'vb1'$$, 'true', 'V16-B8 저장된 내용 해시가 승인 내용에서 다시 계산한 값과 같음(무결성)');
-- 모름은 모름, 0원은 0원
select test.v16_publish('vb2', test.v16_terms(27700, 'included', 2200, 'excluded', null, 5500));
select test.v16_publish('vb3', test.v16_terms(27700, 'included', 2200, 'excluded', '0', 5500));
set role app_public;
select test.expect_eq($$select (p -> 'installFee')::text from api.policy_published() p where p ->> 'productId' = 'vb2'$$, '{"known": false}', 'V16-B9 설치비 "모름"은 모름 그대로 게시(0원·값으로 바뀌지 않음)');
select test.expect_eq($$select (p #>> '{installFee,value,amountKrw}') || '|' || (p #>> '{installFee,known}') from api.policy_published() p where p ->> 'productId' = 'vb3'$$, '0|true', 'V16-B10 설치비 확정 0원은 "확인된 0원"으로 게시(모름과 구분)');
reset role;
-- 승인된 내용은 어떤 경로로도 바꿀 수 없다
select test.expect_error_msg($$update core.policy_versions set terms = jsonb_set(terms, '{monthlyFee,value,amountKrw}', '1'::jsonb) where product_id = 'vb1'$$, '42501', 'POLICY_IMMUTABLE', 'V16-B11 승인된 월요금 직접 수정 불가(관리자 연결 포함)');
select test.expect_error_msg($$update core.policy_versions set product_label = '바꾼 이름' where product_id = 'vb1'$$, '42501', 'POLICY_IMMUTABLE', 'V16-B12 승인된 정책의 상품명 수정 불가');
select test.expect_error_msg($$delete from core.policy_versions where product_id = 'vb1'$$, '42501', 'POLICY_IMMUTABLE', 'V16-B13 승인된 정책 삭제 불가');
select test.expect_eq($$select ((current_setting('t.v16_pub')::jsonb -> 'monthlyFee') = (select p -> 'monthlyFee' from api.policy_published() p where p ->> 'productId' = 'vb1'))::text$$, 'true', 'V16-B14 수정 시도 뒤에도 게시 월요금은 승인 값 그대로');
-- 필수 고지 문구(저장소) 무결성
select test.expect_eq($$select (count(*) > 0)::text || ',' || count(*) filter (where body_sha256 <> encode(sha256(convert_to(body, 'UTF8')), 'hex'))::text from core.notice_texts$$, 'true,0', 'V16-B15 저장된 필수 고지 문구 전부 본문 해시가 본문과 일치');
select test.expect_eq($$select count(*)::text from pii.notice_exposures e where not exists (select 1 from core.notice_texts n where n.version = e.doc_version and n.notice_key = e.notice_key and n.body_sha256 = e.body_sha256)$$, '0', 'V16-B16 고객에게 보여 준 고지 기록은 모두 저장된 고지 문구(버전·키·해시)와 일치');
insert into core.notice_texts (version, notice_key, body, body_sha256) values ('v16-test', 'k1', '시험 고지 본문', repeat('0', 64));
select test.expect_eq($$select (body_sha256 = encode(sha256(convert_to('시험 고지 본문', 'UTF8')), 'hex'))::text from core.notice_texts where version = 'v16-test' and notice_key = 'k1'$$, 'true', 'V16-B17 호출자가 준 가짜 해시는 무시하고 본문에서 계산한 해시를 저장');
select test.expect_error_msg($$update core.notice_texts set body = '바꾼 본문' where version = 'v16-test'$$, '42501', 'NOTICE_IMMUTABLE', 'V16-B18 저장된 고지 문구 수정 불가');
select test.expect_error_msg($$delete from core.notice_texts where version = 'v16-test'$$, '42501', 'NOTICE_IMMUTABLE', 'V16-B19 저장된 고지 문구 삭제 불가');

-- ---------------------------------------------------------------------------------------------------------------------
-- C. 캐시 구조: 게시 함수는 호출마다 현재 상태를 읽는다(앱 쪽 캐시 없음은 tests/route/policy-pr16-verify.test.ts V9·V10)
-- ---------------------------------------------------------------------------------------------------------------------
select test.expect_eq($$select provolatile::text from pg_proc where oid = 'api.policy_published()'::regprocedure$$, 's', 'V16-C1 api.policy_published()는 STABLE(IMMUTABLE로 결과를 고정하지 않음)');
select test.expect_eq($$select count(*)::text from pg_matviews$$, '0', 'V16-C2 구체화 뷰(저장된 사본) 없음: 게시 결과가 별도 사본으로 남아 낡을 수 없음');
set role app_public;
select set_config('t.v16_n1', (select count(*)::text from api.policy_published() p where p ->> 'productId' like 'vb%'), false);
reset role;
select test.v16_publish('vb4', test.v16_terms(31000, 'included', 0, 'included', '0', 0));
set role app_public;
select test.expect_eq($$select (count(*)::int - current_setting('t.v16_n1')::int)::text from api.policy_published() p where p ->> 'productId' like 'vb%'$$, '1', 'V16-C3 같은 연결·같은 트랜잭션에서도 새로 승인한 정책이 다음 호출에 즉시 보임');
reset role;
select test.expect_ok(test.v16_pub_set(false), 'V16-C4a 대표가 게시 OFF');
set role app_public;
select test.expect_eq($$select count(*)::text from api.policy_published()$$, '0', 'V16-C4 게시 OFF 직후 호출은 0건(이전 결과 재사용 없음)');
reset role;
select test.expect_ok(test.v16_pub_set(true), 'V16-C4b 대표가 게시 ON');
set role app_public;
select test.expect_eq($$select (count(*) > 0)::text from api.policy_published()$$, 'true', 'V16-C5 게시 ON 직후 호출은 다시 정책을 돌려줌');
reset role;

-- ---------------------------------------------------------------------------------------------------------------------
-- D. 트랜잭션 실패·롤백: 감사 기록 저장 단계에서 실패하면 앞선 변경이 하나도 남지 않는다(실패 주입 트리거)
-- ---------------------------------------------------------------------------------------------------------------------
select test.v16_publish('vd1', test.v16_terms(10000, 'included', 0, 'included', '0', 0));          -- r1 승인·게시
set role app_staff;
select set_config('t.v16_r2', (select test.v16_draft('editor', 'vd1', 'internet_tv', test.v16_terms(11000, 'included', 0, 'included', '0', 0))), false);
reset role;
select test.expect_ok(current_setting('t.v16_r2'), 'V16-D0 r2 초안 작성');
select test.expect_ok(test.v16_call('editor', 'policy_submit', test.v16_id('vd1', 2)), 'V16-D0b r2 제출(승인 대기)');

-- D1 승인 중 실패: 기존 승인본 교체(superseded)와 새 승인이 모두 취소되어야 한다
select set_config('t.v16_snap', test.v16_snap(), false);
select set_config('test.v16_fail_action', 'policy.approve', false);
set role app_staff;
select test.expect_error(test.v16_call('owner', 'policy_approve', test.v16_id('vd1', 2), test.v16_checks()), 'XX999', 'V16-D1 승인 도중 감사 기록 실패 → 승인 전체 실패');
reset role;
select test.expect_eq($$select test.v16_snap()$$, current_setting('t.v16_snap'), 'V16-D1b 실패 뒤 정책 수·감사 수·버전 상태·게시 스위치가 실패 전과 완전히 같음');
select test.expect_eq($$select string_agg(state || ':' || coalesce(superseded_at::text, '-') || ':' || coalesce(decided_by::text, '-'), ',' order by revision) from core.policy_versions where product_id = 'vd1'$$,
  'approved:-:00000000-0000-4000-8000-000000000001,submitted:-:-', 'V16-D1c 기존 승인본은 승인 그대로(교체 시각 없음), 새 버전은 제출 상태 그대로(승인자 없음)');
set role app_public;
select test.expect_eq($$select p ->> 'version' from api.policy_published() p where p ->> 'productId' = 'vd1'$$, 'r1', 'V16-D1d 고객에게는 계속 기존 승인본(r1)이 게시되고, 반쯤 바뀐 상태가 노출되지 않음');
reset role;
-- D2 대조: 주입을 끄면 같은 호출이 성공하고 r1은 교체됨(실패 원인이 주입이었다는 증명)
select set_config('test.v16_fail_action', '', false);
set role app_staff;
select test.expect_ok(test.v16_call('owner', 'policy_approve', test.v16_id('vd1', 2), test.v16_checks()), 'V16-D2 대조: 주입 해제 후 같은 승인은 성공');
reset role;
select test.expect_eq($$select string_agg(state, ',' order by revision) from core.policy_versions where product_id = 'vd1'$$, 'superseded,approved', 'V16-D2b 성공하면 r1 superseded·r2 approved');

-- D3 초안 작성 중 실패: 초안 행이 남지 않고 버전 번호도 소비되지 않는다
select set_config('t.v16_snap', test.v16_snap(), false);
select set_config('test.v16_fail_action', 'policy.draft', false);
set role app_staff;
select test.expect_error(test.v16_draft('editor', 'vd1', 'internet_tv', test.v16_terms(12000, 'included', 0, 'included', '0', 0)), 'XX999', 'V16-D3 초안 작성 도중 실패');
reset role;
select test.expect_eq($$select test.v16_snap()$$, current_setting('t.v16_snap'), 'V16-D3b 실패한 초안 행·감사 기록이 남지 않음');
select set_config('test.v16_fail_action', '', false);
set role app_staff;
select set_config('t.v16_r3', test.v16_draft('editor', 'vd1', 'internet_tv', test.v16_terms(12000, 'included', 0, 'included', '0', 0)), false);
reset role;
select test.expect_ok(current_setting('t.v16_r3'), 'V16-D3c 주입 해제 후 초안 작성 성공');
select test.expect_eq($$select max(revision)::text from core.policy_versions where product_id = 'vd1'$$, '3', 'V16-D3d 실패한 시도가 버전 번호를 소비하지 않음(다음 버전은 정확히 r3, 빈 번호 없음)');

-- D4 제출 중 실패: 초안 상태 유지
select set_config('test.v16_fail_action', 'policy.submit', false);
set role app_staff;
select test.expect_error(test.v16_call('editor', 'policy_submit', test.v16_id('vd1', 3)), 'XX999', 'V16-D4 제출 도중 실패');
reset role;
select test.expect_eq($$select state from core.policy_versions where product_id = 'vd1' and revision = 3$$, 'draft', 'V16-D4b 실패하면 초안 상태 그대로(제출 시각도 없음)');
select test.expect_eq($$select (submitted_at is null)::text from core.policy_versions where product_id = 'vd1' and revision = 3$$, 'true', 'V16-D4c 제출 시각 없음');
select set_config('test.v16_fail_action', '', false);
select test.expect_ok(test.v16_call('editor', 'policy_submit', test.v16_id('vd1', 3)), 'V16-D4d 대조: 주입 해제 후 제출 성공');

-- D5 반려 중 실패: 제출 상태 유지(반려 사유·결정자 없음)
select set_config('test.v16_fail_action', 'policy.reject', false);
set role app_staff;
select test.expect_error(test.v16_call('owner', 'policy_reject', test.v16_id('vd1', 3), ', ''시험 반려 사유''::text'), 'XX999', 'V16-D5 반려 도중 실패');
reset role;
select test.expect_eq($$select state || ':' || coalesce(decision_reason, '-') || ':' || coalesce(decided_by::text, '-') from core.policy_versions where product_id = 'vd1' and revision = 3$$, 'submitted:-:-', 'V16-D5b 실패하면 제출 상태 그대로(사유·결정자 기록 없음)');
select set_config('test.v16_fail_action', '', false);

-- D6 게시 스위치 변경 중 실패: 스위치 값·수정 정보가 그대로, 고객 게시 상태도 그대로
select set_config('t.v16_flag', (select enabled::text || '|' || coalesce(updated_by::text, '-') || '|' || updated_at::text from core.feature_flags where key = 'policy_publish'), false);
select set_config('test.v16_fail_action', 'policy.publish_off', false);
set role app_staff;
select test.expect_error(test.v16_pub_set(false), 'XX999', 'V16-D6 게시 OFF 도중 실패');
reset role;
select test.expect_eq($$select enabled::text || '|' || coalesce(updated_by::text, '-') || '|' || updated_at::text from core.feature_flags where key = 'policy_publish'$$, current_setting('t.v16_flag'), 'V16-D6b 실패하면 스위치 값·변경자·변경 시각이 그대로(절반만 바뀌지 않음)');
set role app_public;
select test.expect_eq($$select (count(*) > 0)::text from api.policy_published()$$, 'true', 'V16-D6c 실패한 OFF는 게시 상태를 바꾸지 않음(운영자는 오류를 받고 다시 시도해야 함)');
reset role;
select set_config('test.v16_fail_action', '', false);
select test.expect_ok(test.v16_pub_set(false), 'V16-D6d 대조: 주입 해제 후 OFF 성공');
select set_config('t.v16_flag', (select enabled::text || '|' || coalesce(updated_by::text, '-') || '|' || updated_at::text from core.feature_flags where key = 'policy_publish'), false);
select set_config('test.v16_fail_action', 'policy.publish_on', false);
set role app_staff;
select test.expect_error(test.v16_pub_set(true), 'XX999', 'V16-D7 게시 ON 도중 실패');
reset role;
select test.expect_eq($$select enabled::text || '|' || coalesce(updated_by::text, '-') || '|' || updated_at::text from core.feature_flags where key = 'policy_publish'$$, current_setting('t.v16_flag'), 'V16-D7b 실패한 ON은 OFF 상태를 그대로 둠');
set role app_public;
select test.expect_eq($$select count(*)::text from api.policy_published()$$, '0', 'V16-D7c 실패한 ON 뒤에도 고객 게시는 0건(안전한 쪽으로 닫힘)');
reset role;
select set_config('test.v16_fail_action', '', false);

-- ---------------------------------------------------------------------------------------------------------------------
-- E. Supabase 공식 문서 기준 구조 점검(로컬 가상 DB). 문서 근거와 호스팅 고유 항목은 PR 보고서 참고
-- ---------------------------------------------------------------------------------------------------------------------
select test.expect_eq($$select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('core', 'pii', 'security', 'api', 'public') and not c.relrowsecurity$$, '0', 'V16-E1 RLS: core·pii·security·api·public의 모든 테이블에 행 수준 보안 활성');
select test.expect_eq($$select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname = 'public'$$, '0', 'V16-E2 노출되기 쉬운 public 스키마에 테이블·뷰 없음');
select test.expect_eq($$select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm', 'f') and n.nspname in ('core', 'pii', 'security', 'api', 'public')
    and not coalesce((select option_value::boolean from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), false)$$, '0', 'V16-E3 뷰는 없거나 모두 security_invoker(뷰가 RLS를 우회하지 않음)');
select test.expect_eq($$select (count(*) > 0)::text || ',' || count(*) filter (where not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prosecdef and n.nspname in ('core', 'pii', 'security', 'api', 'public')$$, 'true,0', 'V16-E4 SECURITY DEFINER 함수는 전부 search_path를 고정(검색 경로 가로채기 방지)');
select test.expect_eq($$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname in ('core', 'pii', 'security', 'api', 'public')
    and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%' and c not in ('search_path=""', 'search_path='))$$, '0', 'V16-E4b SECURITY DEFINER 함수의 search_path는 빈 값(모든 객체를 스키마 이름까지 적어 참조)');
select test.expect_eq($$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('api', 'core', 'pii', 'security') and has_function_privilege('public', p.oid, 'execute')$$, '0', 'V16-E5 함수 실행 권한이 PUBLIC에 열려 있지 않음(기본값으로 아무나 호출 불가)');
select test.expect_eq($$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api' and has_function_privilege('app_public', p.oid, 'execute')
    and p.proname ~ '^(policy_(create_draft|submit|approve|reject|list|publish_get|publish_set)|notice_text_|product_|ad_|ai_)'$$, '0', 'V16-E6 고객 역할은 정책 작성·승인·게시 변경·광고·AI 관리 함수를 직접 호출할 수 없음(RPC 직접 호출 우회 차단)');
select test.expect_eq($$select count(*)::text from (values ('app_public'), ('app_staff')) r(role), (values ('core.policy_versions'), ('core.feature_flags'), ('core.audit_logs'), ('core.product_catalog'), ('core.notice_texts'), ('core.staff')) t(tbl)
  where has_table_privilege(r.role, t.tbl, 'select,insert,update,delete')$$, '0', 'V16-E7 고객·직원 역할은 정책·스위치·감사·상품·고지·직원 테이블에 직접 권한이 없음(함수 경유만)');
select test.expect_eq($$select count(*)::text from pg_roles where rolname in ('app_public', 'app_staff', 'app_ai', 'app_ad_monitor', 'fideon_api') and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb)$$, '0', 'V16-E8 앱 역할은 슈퍼유저·RLS 우회·역할/DB 생성 권한이 없음');
select test.expect_eq($$select count(*)::text from pg_roles where rolname in ('app_public', 'app_staff') and rolcanlogin$$, '0', 'V16-E9 고객·직원 역할은 직접 로그인 불가(서버가 SET ROLE로만 사용)');

rollback;
