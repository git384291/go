-- 정책 저장소 0008: 초안 → 제출 → 승인(교체) → 게시. 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1

insert into core.staff (user_id, role, active) values ('00000000-0000-4000-8000-000000000006', 'policy_editor', true);
insert into security.staff_sessions (id, user_id, created_at, revoked_at) values
  ('10000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000006', now(), null);

create function test.pterms(p_known boolean default true) returns text language sql security definer set search_path = test, pg_catalog as $$
  select case when p_known then
    '{"monthlyFee":{"known":true,"value":{"amountKrw":11111,"vat":"included"}},"contractMonths":{"known":true,"value":36},"equipmentMonthlyFee":{"known":true,"value":{"amountKrw":0,"vat":"included"}},"installFee":{"known":true,"value":{"amountKrw":2222,"vat":"included"}},"bundlePrerequisites":{"known":true,"value":[]},"regionScope":{"known":true,"value":"nationwide"},"customerBenefit":{"known":true,"value":{"amountKrw":3333,"form":"gift_card","payoutCondition":{"known":true,"value":"x"},"cancellationCondition":{"known":true,"value":"y"}}}}'
  else '{"monthlyFee":{"known":true}}' end $$;

-- p_who: owner | editor | counselor
create function test.pdraft(p_who text, p_product text default 'p1', p_category text default 'internet_tv', p_terms text default null,
                            p_source text default 'official_policy_sheet', p_until text default 'now() + interval ''1 day''') returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'editor' then '00000000-0000-4000-8000-000000000006' else '00000000-0000-4000-8000-000000000002' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'editor' then '10000000-0000-4000-8000-000000000008' else '10000000-0000-4000-8000-000000000002' end;
begin
  return format('select api.policy_create_draft(%L, %L, %L, ''supplier-a'', ''household'', ''carrier-x'', %L, %L, %L, now() - interval ''1 hour'', now() - interval ''1 hour'', %s, ''가상 인터넷+TV'', %L::jsonb)',
                a, s, test.staff_token(a, s), p_product, p_category, p_source, p_until, coalesce(p_terms, test.pterms()));
end $$;
create function test.pcall(p_who text, p_fn text, p_id text, p_extra text default '') returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'editor' then '00000000-0000-4000-8000-000000000006' else '00000000-0000-4000-8000-000000000002' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'editor' then '10000000-0000-4000-8000-000000000008' else '10000000-0000-4000-8000-000000000002' end;
begin
  return format('select api.%s(%L, %L, %L, %L%s)', p_fn, a, s, test.staff_token(a, s), p_id, p_extra);
end $$;
create function test.allchecks() returns text language sql security definer set search_path = test, pg_catalog as $$
  select ', ''확인 완료''::text, ''{"source_matched":true,"validity":true,"vat":true,"benefit_terms":true,"region_bundle":true}''::jsonb' $$;

set role app_staff;
select set_config('t.d1', (select test.pdraft('editor')), false);
select test.expect_ok(current_setting('t.d1'), 'P1 policy_editor 초안 작성');
select test.expect_error(test.pdraft('counselor'), '42501', 'P2 상담원은 초안 작성 불가');
select test.expect_error(test.pdraft('owner', p_category => 'internet_phone'), 'FP001', 'P3 비활성 상품 정책은 만들 수 없음');
select test.expect_error(test.pdraft('owner', p_terms => test.pterms(false)), '23514', 'P4 형태가 틀린 terms 거부');
reset role;

-- 초안 id 확보(관리자 연결)
select set_config('t.id1', (select id::text from core.policy_versions where product_id = 'p1' and revision = 1), false);
select test.expect_eq($$select state from core.policy_versions where id = current_setting('t.id1')::uuid$$, 'draft', 'P5 초안 상태');

set role app_staff;
select test.expect_ok(test.pcall('editor', 'policy_submit', current_setting('t.id1')), 'P6 작성자 제출');
select test.expect_error(test.pcall('editor', 'policy_approve', current_setting('t.id1'), test.allchecks()), '42501', 'P7 policy_editor는 승인 불가');
select test.expect_error(test.pcall('counselor', 'policy_approve', current_setting('t.id1'), test.allchecks()), '42501', 'P8 상담원은 승인 불가');
select test.expect_error(test.pcall('owner', 'policy_approve', current_setting('t.id1'), ', ''확인''::text, ''{"source_matched":true}''::jsonb'), '22023', 'P9 확인 항목이 빠지면 승인 불가');
select test.expect_error(test.pcall('owner', 'policy_approve', current_setting('t.id1'), ', ''''::text, ''{"source_matched":true,"validity":true,"vat":true,"benefit_terms":true,"region_bundle":true}''::jsonb'), '22023', 'P10 사유 없으면 승인 불가');
reset role;

-- 인용 불가 출처는 승인 불가
set role app_staff;
select set_config('t.d_bad', (select test.pdraft('owner', p_product => 'p2', p_source => 'past_promotion')), false);
select test.expect_ok(current_setting('t.d_bad'), 'P11a owner 초안(과거 프로모션 출처)');
reset role;
select set_config('t.id_bad', (select id::text from core.policy_versions where product_id = 'p2'), false);
set role app_staff;
select test.expect_ok(test.pcall('owner', 'policy_submit', current_setting('t.id_bad')), 'P11 owner 제출(과거 프로모션 출처)');
select test.expect_error(test.pcall('owner', 'policy_approve', current_setting('t.id_bad'), test.allchecks()), '22023', 'P12 인용 불가 출처는 승인 불가');
-- 정상 승인
select test.expect_ok(test.pcall('owner', 'policy_approve', current_setting('t.id1'), test.allchecks()), 'P13 owner 승인');
reset role;
select test.expect_eq($$select state || ',' || self_approval::text from core.policy_versions where id = current_setting('t.id1')::uuid$$, 'approved,false', 'P14 승인 상태·자체 승인 아님(작성자 ≠ 승인자)');

-- 게시: 스위치가 꺼져 있으면 아무것도 나가지 않는다
set role app_public;
select test.expect_eq($$select count(*)::text from api.policy_published()$$, '0', 'P15 policy_publish 꺼짐 → 게시 0건');
reset role;
update core.feature_flags set enabled = true where key = 'policy_publish';
set role app_public;
select test.expect_eq($$select count(*)::text from api.policy_published()$$, '1', 'P16 스위치 켬 + 승인 + 유효 → 1건');
select test.expect_eq($$select (p ? 'internal')::text || (p::text ~* 'commission|source_?ref')::text || (p->>'reviewStatus') from api.policy_published() p$$, 'falsefalseapproved', 'P17 게시 결과에 수수료·원문 위치 없음');
select test.expect_eq($$select p->>'confirmedAt' ~ '\+09:00$' and p->'validUntil'->>'value' ~ '\+09:00$' from api.policy_published() p$$, 'true', 'P18 시각은 오프셋 포함 ISO');
reset role;

-- 교체: 같은 키의 새 revision을 승인하면 이전 승인본은 superseded, 승인본은 항상 1개
set role app_staff;
select set_config('t.d2', (select test.pdraft('owner')), false);
select test.expect_ok(current_setting('t.d2'), 'P18a 같은 키 새 revision 초안');
reset role;
select set_config('t.id2', (select id::text from core.policy_versions where product_id = 'p1' and revision = 2), false);
set role app_staff;
select test.expect_ok(test.pcall('owner', 'policy_submit', current_setting('t.id2')), 'P19 새 revision 제출');
select test.expect_ok(test.pcall('owner', 'policy_approve', current_setting('t.id2'), test.allchecks()), 'P20 새 revision 승인(교체)');
reset role;
select test.expect_eq($$select string_agg(revision || ':' || state, ',' order by revision) from core.policy_versions where product_id = 'p1'$$, '1:superseded,2:approved', 'P21 이전 승인본 교체');
select test.expect_eq($$select self_approval::text from core.policy_versions where id = current_setting('t.id2')::uuid$$, 'true', 'P22 owner가 작성·승인하면 자체 승인 표시');

-- 불변·삭제 금지·상태 전이 보호
select test.expect_error($$update core.policy_versions set terms = '{}'::jsonb where state = 'approved'$$, '42501', 'P23 승인본 내용 수정 불가');
select test.expect_error($$update core.policy_versions set product_label = 'x' where state = 'superseded'$$, '42501', 'P24 교체된 버전 내용 수정 불가');
select test.expect_error($$delete from core.policy_versions$$, '42501', 'P25 정책 삭제 불가');
select test.expect_error($$update core.policy_versions set state = 'approved' where state = 'superseded'$$, '22023', 'P26 허용되지 않은 상태 전이 거부');

set role app_public;
select test.expect_eq($$select count(*)::text from api.policy_published()$$, '1', 'P28 유효한 승인본만 1건');
reset role;

-- 권한: 앱 역할은 테이블 직접 접근 불가
set role app_public;
select test.expect_error($$select * from core.policy_versions$$, '42501', 'P29 공개 역할 정책 테이블 조회 불가');
reset role;
set role app_staff;
select test.expect_error($$select * from core.policy_versions$$, '42501', 'P30 직원 역할도 정책 테이블 직접 조회 불가');
reset role;

-- 감사 로그: 초안·제출·승인 행위가 남고 사유·자체 승인 여부가 기록된다
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'policy.approve' and target_type = 'policy_version'$$, '2', 'P31 승인 감사 로그 2건');
select test.expect_eq($$select count(*)::text from core.audit_logs where action in ('policy.draft', 'policy.submit')$$, '6', 'P32 초안 3건·제출 3건 감사 로그');
select test.expect_eq($$select (detail->>'self_approval') from core.audit_logs where action = 'policy.approve' order by id desc limit 1$$, 'true', 'P33 감사 로그에 자체 승인 여부');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'policy.%' and detail::text ~* 'commission|terms|monthly'$$, '0', 'P34 감사 로그에 요금·수수료 값 없음');
