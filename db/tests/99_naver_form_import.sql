-- 0071 네이버 폼 결과 가져오기: 대표만, 정확한 동의 고지, 암호문, 중복·멱등, 공개 차단. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
update core.feature_flags set enabled = true where key = 'lead_form';
select '00000000-0000-4000-8000-000000000001'::uuid as owner_id,
       '10000000-0000-4000-8000-000000000001'::uuid as owner_session,
       '00000000-0000-4000-8000-000000000002'::uuid as counselor_id,
       '10000000-0000-4000-8000-000000000002'::uuid as counselor_session \gset
select test.staff_token(:'owner_id', :'owner_session') as owner_token,
       test.staff_token(:'counselor_id', :'counselor_session') as counselor_token \gset

set role app_staff;
select test.expect_error(
  format($$select api.naver_form_import(%L,%L,%L,'v1:n','가*객','v1:p',repeat('e9',32),'2222','v1:a',now()-interval '1 hour','naver-%s',true,'naver-form-2026-11-28')$$,
    :'counselor_id', :'counselor_session', :'counselor_token', repeat('1',58)),
  '42501', 'NFDB1 대표 외 가져오기 차단');

select test.expect_error_msg(
  format($$select api.naver_form_import(%L,%L,%L,'v1:n','가*객','v1:p',repeat('e9',32),'2222','v1:a',now()-interval '1 hour','naver-%s',false,'naver-form-2026-11-28')$$,
    :'owner_id', :'owner_session', :'owner_token', repeat('2',58)),
  '22023', 'CONSENT_REQUIRED', 'NFDB2 비동의 차단');

select test.expect_eq(
  format($$select api.naver_form_import(%L,%L,%L,'v1:name','가*객','v1:phone',repeat('e9',32),'2222','v1:area',now()-interval '1 hour','naver-%s',true,'naver-form-2026-11-28')$$,
    :'owner_id', :'owner_session', :'owner_token', repeat('3',58)),
  'imported', 'NFDB3 신규 접수');
reset role;
select test.expect_eq($$select count(*)::text from core.leads where idempotency_key = 'naver-$$ || repeat('3',58) || $$' and interest = 'internet_tv' and utm_source = 'naver'$$, '1', 'NFDB4 출처·상품 저장');
select test.expect_eq($$select count(*)::text from pii.consents c join pii.customers p on p.id=c.customer_id where p.phone_hmac=repeat('e9',32) and c.doc_version='naver-form-2026-11-28' and c.granted$$, '1', 'NFDB5 동의 기록');
select test.expect_eq($$select count(*)::text from pii.notice_exposures e join pii.customers p on p.id=e.customer_id where p.phone_hmac=repeat('e9',32) and e.doc_version='naver-form-2026-11-28' and e.body_sha256=(select body_sha256 from core.notice_texts where version=e.doc_version and notice_key=e.notice_key)$$, '1', 'NFDB6 고지 해시 기록');
select test.expect_eq($$select count(*)::text from pii.customers where phone_hmac=repeat('e9',32) and address_enc='v1:area'$$, '1', 'NFDB7 지역 암호문 저장');
select test.expect_eq($$select count(*)::text from pii.customers c join pii.naver_form_import_receipts r on r.customer_id=c.id where c.phone_hmac=repeat('e9',32) and c.retention_until=r.responded_at+interval '30 days'$$, '1', 'NFDB7b 응답시각부터 정확히 30일 보유');
select test.expect_eq($$select body from core.notice_texts where version='naver-form-2026-11-28' and notice_key='collection_use'$$,
  E'수집 및 이용하는 개인정보 항목\n성함, 휴대전화번호, 설치 희망 지역(시·군·구)\n수집 및 이용 목적\n인터넷 가입 접수 확인, 가입 조건 안내 및 연락\n보유 및 이용기간\n접수일로부터 30일 후 파기. 단, 관계 법령에 따라 보존이 필요한 경우 해당 법령에서 정한 기간', 'NFDB7c 실제 네이버 고지 원문 고정');

set role app_staff;
select test.expect_eq(
  format($$select api.naver_form_import(%L,%L,%L,'v1:name','가*객','v1:phone',repeat('e9',32),'2222','v1:area',now()-interval '1 hour','naver-%s',true,'naver-form-2026-11-28')$$,
    :'owner_id', :'owner_session', :'owner_token', repeat('3',58)),
  'already', 'NFDB8 같은 파일 재업로드 멱등');
select test.expect_eq(
  format($$select api.naver_form_import(%L,%L,%L,'v1:name','가*객','v1:phone',repeat('e9',32),'2222','v1:area2',now()-interval '30 minutes','naver-%s',true,'naver-form-2026-11-28')$$,
    :'owner_id', :'owner_session', :'owner_token', repeat('4',58)),
  'duplicate', 'NFDB9 같은 연락처 새 응답은 중복 리드 차단·동의 갱신');
reset role;
select test.expect_eq($$select count(*)::text from core.leads l join pii.customers p on p.id=l.customer_id where p.phone_hmac=repeat('e9',32)$$, '1', 'NFDB10 중복 리드 없음');
select test.expect_eq($$select count(*)::text from pii.consents c join pii.customers p on p.id=c.customer_id where p.phone_hmac=repeat('e9',32) and c.doc_version='naver-form-2026-11-28'$$, '2', 'NFDB11 응답별 동의 2건');
set role app_staff;
select test.expect_eq(
  format($$select api.naver_form_import(%L,%L,%L,'v1:name','가*객','v1:phone',repeat('e9',32),'2222','v1:area2',now()-interval '30 minutes','naver-%s',true,'naver-form-2026-11-28')$$,
    :'owner_id', :'owner_session', :'owner_token', repeat('4',58)),
  'already', 'NFDB12 중복 응답 파일 재업로드 멱등');
reset role;
select test.expect_eq($$select count(*)::text from pii.naver_form_import_receipts where customer_id=(select id from pii.customers where phone_hmac=repeat('e9',32))$$, '2', 'NFDB13 응답 영수증 2건');
select test.expect_eq($$select count(*)::text from pii.consents c join pii.customers p on p.id=c.customer_id where p.phone_hmac=repeat('e9',32) and c.doc_version='naver-form-2026-11-28'$$, '2', 'NFDB14 재업로드 시 동의 중복 없음');
select test.expect_eq($$select address_enc from pii.customers where phone_hmac=repeat('e9',32)$$, 'v1:area2', 'NFDB15 고객 최신 지역');
select test.expect_eq($$select string_agg(area_enc,',' order by responded_at) from pii.naver_form_import_receipts where customer_id=(select id from pii.customers where phone_hmac=repeat('e9',32))$$, 'v1:area,v1:area2', 'NFDB16 응답별 지역 보존');
set role app_public;
select test.expect_error($$select api.naver_form_import(null,null,null,null,null,null,null,null,null,null,null,null,null)$$, '42501', 'NFDB17 공개 역할 실행 불가');
reset role;
