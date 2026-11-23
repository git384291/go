-- 0027 광고 클릭 식별값(gclid) 접수 귀속(PM 11/24 광고 사전검증 8번). 가상 데이터만, Google 전송 없음.
\set ON_ERROR_STOP 1

-- 서버와 같은 서명 호출문(관리자 연결에서 만들고 app_public으로 실행)
create function test.gclid_sql(p_idem text, p_hmac text, p_gclid text, p_tamper text default null) returns text
language plpgsql as $$
declare
  v_tok text := test.token('lead', array['gclid', p_idem, p_hmac, p_gclid]);
begin
  return format('select api.lead_gclid_attach(%L, %L, %L, %L)', v_tok, p_idem, p_hmac, coalesce(p_tamper, p_gclid));
end
$$;
create function test.click_of(p_idem text) returns text language sql security definer set search_path = pg_catalog as $$
  select coalesce((select k.gclid from pii.lead_clicks k join core.leads l on l.id = k.lead_id where l.idempotency_key = p_idem), '(없음)') $$;

-- 리드 2건(가상): A(연락처 a1…), B(연락처 b1…)
select set_config('t.g_a', test.lead_sql(repeat('a1', 32), 'idem-gclid-00000000a', p_ip => repeat('a', 63) || '1'), false);
select set_config('t.g_b', test.lead_sql(repeat('b1', 32), 'idem-gclid-00000000b', p_ip => repeat('a', 63) || '2'), false);
select set_config('t.g1',  test.gclid_sql('idem-gclid-00000000a', repeat('a1', 32), 'Cj0KCQiA_firstClick-001'), false);
select set_config('t.g2',  test.gclid_sql('idem-gclid-00000000a', repeat('a1', 32), 'Cj0KCQiA_secondClick-02'), false);
select set_config('t.g_tamper', test.gclid_sql('idem-gclid-00000000b', repeat('b1', 32), 'Cj0KCQiA_realValue-0001', 'Cj0KCQiA_attacker-00001'), false);
select set_config('t.g_none', test.gclid_sql('idem-gclid-00000000z', repeat('c9', 32), 'Cj0KCQiA_noLeadForPhone'), false);
-- 형식 밖 값(서명은 정상): 짧음·특수문자(스크립트)·전화번호(숫자만)·숫자 9자리 연속·201자·공백
select set_config('t.bad1', test.gclid_sql('idem-gclid-00000000b', repeat('b1', 32), 'Abc123'), false);
select set_config('t.bad2', test.gclid_sql('idem-gclid-00000000b', repeat('b1', 32), '<script>alert(1)</script>'), false);
select set_config('t.bad3', test.gclid_sql('idem-gclid-00000000b', repeat('b1', 32), '01012345678'), false);
select set_config('t.bad4', test.gclid_sql('idem-gclid-00000000b', repeat('b1', 32), 'Cj0K_010123456789_x'), false);
select set_config('t.bad5', test.gclid_sql('idem-gclid-00000000b', repeat('b1', 32), repeat('Ab', 100) || 'X'), false);
select set_config('t.bad6', test.gclid_sql('idem-gclid-00000000b', repeat('b1', 32), 'Cj0KCQiA first'), false);

set role app_public;
select test.expect_eq(current_setting('t.g_a'), 'accepted', 'GC0 리드 A 접수');
select test.expect_eq(current_setting('t.g_b'), 'accepted', 'GC0b 리드 B 접수');
select test.expect_eq(current_setting('t.g1'), 'attached', 'GC1 서명된 gclid → 리드 A에 귀속');
select test.expect_eq(current_setting('t.g2'), 'kept_first', 'GC2 같은 연락처의 두 번째 클릭(재방문·중복)은 첫 값 유지');
select test.expect_error(current_setting('t.g_tamper'), '42501', 'GC3 서명 뒤 gclid 변조 거부');
select test.expect_eq(current_setting('t.g_none'), 'skipped', 'GC4 연결할 접수가 없으면 저장 안 함');
select test.expect_eq(current_setting('t.bad1'), 'invalid', 'GC5 너무 짧은 값 거부');
select test.expect_eq(current_setting('t.bad2'), 'invalid', 'GC5b 스크립트·특수문자 거부');
select test.expect_eq(current_setting('t.bad3'), 'invalid', 'GC5c 전화번호(숫자만) 거부');
select test.expect_eq(current_setting('t.bad4'), 'invalid', 'GC5d 숫자 9자리 이상 연속 거부');
select test.expect_eq(current_setting('t.bad5'), 'invalid', 'GC5e 201자 거부');
select test.expect_eq(current_setting('t.bad6'), 'invalid', 'GC5f 공백 포함 거부');
select test.expect_error($$select * from pii.lead_clicks$$, '42501', 'GC6 공개 역할은 gclid 직접 조회 불가');
reset role;
select test.expect_eq($$select test.click_of('idem-gclid-00000000a')$$, 'Cj0KCQiA_firstClick-001', 'GC7 리드 A = 첫 클릭 값(접수 귀속)');
select test.expect_eq($$select test.click_of('idem-gclid-00000000b')$$, '(없음)', 'GC7b 리드 B: 변조·형식 밖 값은 저장 0건');

-- 재문의(같은 연락처, 새 요청 키) → 처음 리드에 귀속(첫 값 유지)
select set_config('t.g_rep', test.lead_sql(repeat('b1', 32), 'idem-gclid-0000000b2', p_ip => repeat('a', 63) || '3'), false);
select set_config('t.g_rep_c', test.gclid_sql('idem-gclid-0000000b2', repeat('b1', 32), 'Cj0KCQiA_repeatVisit-01'), false);
set role app_public;
select test.expect_eq(current_setting('t.g_rep'), 'accepted', 'GC8 같은 연락처 재문의 접수');
select test.expect_eq(current_setting('t.g_rep_c'), 'attached', 'GC8b 재문의의 gclid는 처음 리드(B)에 귀속');
reset role;
select test.expect_eq($$select test.click_of('idem-gclid-00000000b')$$, 'Cj0KCQiA_repeatVisit-01', 'GC8c 리드 B에 연결됨');
select test.expect_eq($$select count(*)::text from core.leads where idempotency_key = 'idem-gclid-0000000b2'$$, '0', 'GC8d 재문의는 새 리드(전환)를 만들지 않음');

-- 권한·수정 금지
set role app_staff;
select test.expect_error($$select api.lead_gclid_attach('x', 'idem-gclid-00000000a', repeat('a1', 32), 'Cj0KCQiA_staffTry-0001')$$, '42501', 'GC9 직원 역할은 gclid 기록 불가');
reset role;
select test.expect_error($$update pii.lead_clicks set gclid = 'Cj0KCQiA_overwrite-0001'$$, '42501', 'GC9b 저장된 gclid 수정 불가(첫 값 보존)');

-- 보존: 수집 90일 지난 값은 정기 파기에서 삭제, 접수 정보 파기 때 함께 삭제
insert into pii.lead_clicks (lead_id, gclid, captured_at)
select l.id, 'Cj0KCQiA_oldClick-00001', now() - interval '91 days' from core.leads l
 where l.purged_at is null and l.id not in (select lead_id from pii.lead_clicks) order by l.created_at limit 1;
select test.expect_eq($$select count(*)::text from pii.lead_clicks where captured_at < now() - interval '90 days'$$, '1', 'GC10 (준비) 90일 지난 값 1건');
select core.purge_expired();
select test.expect_eq($$select count(*)::text from pii.lead_clicks where captured_at < now() - interval '90 days'$$, '0', 'GC10b 정기 파기가 90일 지난 gclid 삭제');
select test.expect_eq($$select test.click_of('idem-gclid-00000000a')$$, 'Cj0KCQiA_firstClick-001', 'GC10c 90일 안의 값은 유지');
select core.purge_customer_internal((select id from core.leads where idempotency_key = 'idem-gclid-00000000a'), null, 'test');
select test.expect_eq($$select test.click_of('idem-gclid-00000000a')$$, '(없음)', 'GC11 접수 정보 파기 때 gclid도 삭제');
