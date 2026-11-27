-- 필수 고지 문구·버전·노출 기록 (0007). 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1

insert into core.settings (key, value) values ('lead_retention_days', '90')
  on conflict (key) do update set value = excluded.value;
update core.feature_flags set enabled = true where key = 'lead_form';

select set_config('t.n_ok',   test.lead_sql(repeat('d', 64), 'idem-notice-000000001', p_ip => repeat('7', 64)), false);
select set_config('t.n_dup',  test.lead_sql(repeat('d', 64), 'idem-notice-000000002', p_ip => repeat('7', 64)), false);
select set_config('t.n_v2',   test.lead_sql(repeat('c', 64), 'idem-notice-000000003', p_version => 'privacy-test-v2', p_ip => repeat('7', 64)), false);

set role app_public;
select test.expect_eq(current_setting('t.n_ok'), 'accepted', 'N1 고지가 있는 문서 버전으로 접수');
reset role;

select test.expect_eq($$select count(*)::text from pii.notice_exposures e join pii.customers c on c.id = e.customer_id
  where c.phone_hmac = repeat('d', 64) and e.doc_version = 'privacy-test-v1'$$, '3', 'N2 고지 3건 노출 기록(고객·문서 버전 단위)');
select test.expect_eq($$select count(*)::text from pii.notice_exposures e join core.notice_texts n
    on n.version = e.doc_version and n.notice_key = e.notice_key and n.body_sha256 = e.body_sha256
  where e.doc_version = 'privacy-test-v1'$$, (select count(*)::text from pii.notice_exposures where doc_version = 'privacy-test-v1'), 'N3 노출 기록의 해시가 저장된 고지 문구와 일치');
select test.expect_eq($$select count(*)::text from core.notice_texts where body_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex')$$,
  (select count(*)::text from core.notice_texts), 'N4 고지 해시는 DB가 문구에서 계산');

set role app_public;
select test.expect_eq(current_setting('t.n_dup'), 'accepted', 'N5 같은 번호 재신청도 같은 응답');
reset role;
select test.expect_eq($$select count(*)::text from pii.notice_exposures e join pii.customers c on c.id = e.customer_id
  where c.phone_hmac = repeat('d', 64)$$, '3', 'N6 재신청은 노출 기록을 늘리지 않음');

select test.expect_error($$update core.notice_texts set body = 'x' where version = 'privacy-test-v1'$$, '42501', 'N7 고지 문구 수정 불가');
select test.expect_error($$delete from core.notice_texts where version = 'privacy-test-v1'$$, '42501', 'N8 고지 문구 삭제 불가');
insert into core.notice_texts (version, notice_key, body, body_sha256) values ('privacy-test-hash', 'x_key', 'abc', repeat('0', 64));
select test.expect_eq($$select (body_sha256 = repeat('0', 64))::text from core.notice_texts where version = 'privacy-test-hash'$$, 'false', 'N9 호출자가 준 해시는 무시');

-- 고지 누락 차단: 새 문서 버전에 고지 문구가 없으면 동의가 있어도 접수하지 않는다
update core.settings set value = '"privacy-test-v2"' where key = 'privacy_policy_version';
set role app_public;
select test.expect_error(current_setting('t.n_v2'), '55000', 'N10 고지 문구 없는 문서 버전 → 접수 차단');
reset role;
update core.settings set value = '"privacy-test-v1"' where key = 'privacy_policy_version';
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac = repeat('c', 64)$$, '0', 'N11 차단 시 고객·동의·노출 기록 없음');

-- 권한
set role app_public;
select test.expect_error($$select * from core.notice_texts$$, '42501', 'N12 공개 역할 고지 테이블 조회 불가');
select test.expect_error($$select * from pii.notice_exposures$$, '42501', 'N13 공개 역할 노출 기록 조회 불가');
reset role;
set role app_staff;
select test.expect_error($$select * from pii.notice_exposures$$, '42501', 'N14 직원 역할도 노출 기록 직접 조회 불가');
reset role;
select test.expect_eq($$select count(*)::text from pg_tables t where t.schemaname in ('core', 'pii') and t.tablename in ('notice_texts', 'notice_exposures')
  and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = t.schemaname and c.relname = t.tablename and c.relrowsecurity and c.relforcerowsecurity)$$,
  '2', 'N15 새 테이블 RLS enable+force');

-- N16~N17: 접수(N1) → DB 저장 → 관리자 조회 한 줄 흐름 (PM 11/21 e2e: DB 계층)
select set_config('t.owner', test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'), false);
-- N1로 저장된 고객(phone_hmac d*64)의 리드가 대표 목록에 마스킹된 상태로 보인다
select test.expect_eq($$select count(*)::text from core.leads l join pii.customers c on c.id = l.customer_id where c.phone_hmac = repeat('d', 64)$$, '1', 'N16 접수한 리드가 DB에 1건 저장');
select set_config('t.n_leads', (select count(*)::text from core.leads where interest = 'internet_tv'), false);
set role app_staff;
select test.expect_eq($$select count(*)::text from api.list_leads('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_setting('t.owner'), 200, 0) where phone_masked ~ '^010-\*\*\*\*-[0-9]{4}$' and interest = 'internet_tv'$$, current_setting('t.n_leads'), 'N17 대표 목록은 접수 건을 마스킹된 전화번호로만 조회');
reset role;
