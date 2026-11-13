-- SEC-02 상담 신청 API, H06 개인정보 접근 함수
\set ON_ERROR_STOP 1

-- 서버가 만드는 것과 같은 서명 호출문을 만든다(테스트 전용, 관리자 연결)
create function test.lead_sql(
  p_hmac text, p_idem text, p_consent boolean default true, p_version text default 'privacy-test-v1',
  p_ip text default repeat('e', 64), p_tamper_name text default null) returns text
language plpgsql as $$
declare
  f text[] := array['v1:enc-name', '테*고', 'v1:enc-phone', p_hmac, '1234', 'internet_tv', '평일 저녁',
                    'naver', 'cpc', 'test', p_idem, p_version, p_consent::text, 'false', p_ip];
  v_tok text := test.token('lead', f);
begin
  if p_tamper_name is not null then
    f[1] := p_tamper_name;      -- 서명 후 값 변조
  end if;
  return format('select api.create_lead(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L::boolean, %L::boolean, %L)',
                v_tok, f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9], f[10], f[11], f[12], f[13], f[14], f[15]);
end
$$;

select set_config('t.l_new',     test.lead_sql(repeat('1', 64), 'idem-test-000000001'), false);
select set_config('t.l_dup',     test.lead_sql(repeat('1', 64), 'idem-test-000000002'), false);
select set_config('t.l_tamper',  test.lead_sql(repeat('3', 64), 'idem-test-000000003', p_tamper_name => 'v1:attacker'), false);
select set_config('t.l_noconsent', test.lead_sql(repeat('4', 64), 'idem-test-000000004', p_consent => false), false);
select set_config('t.l_badver',  test.lead_sql(repeat('5', 64), 'idem-test-000000005', p_version => 'privacy-old'), false);
select set_config('t.l_flag',    test.lead_sql(repeat('6', 64), 'idem-test-000000006'), false);
select set_config('t.l_rate',    test.lead_sql(repeat('7', 64), 'idem-test-000000007', p_ip => repeat('f', 64)), false);

set role app_public;
select test.expect_eq(current_setting('t.l_new'), 'accepted', 'L1 신규 상담 신청');
select test.expect_eq(current_setting('t.l_dup'), 'accepted', 'L2 같은 번호 재신청도 같은 응답(리드 ID·중복 여부 비노출)');
select test.expect_eq(current_setting('t.l_new'), 'accepted', 'L3 같은 요청 재전송');
select test.expect_error(current_setting('t.l_tamper'), '42501', 'L4 서명 후 필드 변조 거부');
select test.expect_error($$select api.create_lead(null, 'v1:x', '테*고', 'v1:x', repeat('9', 64), '1234', 'internet_tv', '', '', '', '',
  'idem-test-000000009', 'privacy-test-v1', true, false, repeat('e', 64))$$, '42501', 'L5 서명 없는 직접 호출 거부');
select test.expect_error(current_setting('t.l_noconsent'), '22023', 'L6 동의 없음 거부');
select test.expect_error(current_setting('t.l_badver'), '22023', 'L7 처리방침 버전 불일치 거부');
select test.expect_error($$select * from api.list_leads(null, null, null, 1, 0)$$, '42501', 'L8 공개 역할은 관리자 함수 실행 불가');
select test.expect_error($$select * from pii.customers$$, '42501', 'L9 공개 역할 고객 테이블 조회 불가');
reset role;

select test.expect_eq($$select count(*)::text from core.leads l join pii.customers c on c.id = l.customer_id
  where c.phone_hmac = repeat('1', 64)$$, '1', 'L10 같은 번호는 리드 1건');
select test.expect_eq($$select count(*)::text from core.lead_status_history h join core.leads l on l.id = h.lead_id
  join pii.customers c on c.id = l.customer_id where c.phone_hmac = repeat('1', 64) and h.reason = 'repeat_inquiry'$$,
  '1', 'L11 재문의 이력 1건');
select test.expect_eq($$select count(*)::text from pii.consents x join pii.customers c on c.id = x.customer_id
  where c.phone_hmac = repeat('1', 64) and x.kind = 'collection_use' and x.doc_version = 'privacy-test-v1'$$,
  '1', 'L12 동의 기록(문서 버전 포함)');

-- 운영 준비 상태 차단
update core.feature_flags set enabled = false where key = 'lead_form';
set role app_public;
select test.expect_error(current_setting('t.l_flag'), '55000', 'L13 상담 폼 스위치 꺼짐 → 거부');
reset role;
update core.feature_flags set enabled = true where key = 'lead_form';
delete from core.settings where key = 'lead_retention_days';
set role app_public;
select test.expect_error(current_setting('t.l_flag'), '55000', 'L14 보유기간 미설정 → 거부');
reset role;
insert into core.settings (key, value) values ('lead_retention_days', '90');

-- IP 해시 시간당 10건 제한
insert into core.audit_logs (action, target_type, detail)
select 'lead.create', 'lead', jsonb_build_object('ip_hash', repeat('f', 64)) from generate_series(1, 10);
set role app_public;
select test.expect_error(current_setting('t.l_rate'), '54000', 'L15 IP당 시간당 10건 초과 거부');
reset role;

-- ===== H06 개인정보 접근 =====
select set_config('t.owner',     test.staff_token('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'), false);
select set_config('t.counselor', test.staff_token('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002'), false);
select set_config('t.reviewer',  test.staff_token('00000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005'), false);

\set C '''00000000-0000-4000-8000-000000000002'', ''10000000-0000-4000-8000-000000000002'', current_setting(''t.counselor'')'
\set O '''00000000-0000-4000-8000-000000000001'', ''10000000-0000-4000-8000-000000000001'', current_setting(''t.owner'')'
\set R '''00000000-0000-4000-8000-000000000005'', ''10000000-0000-4000-8000-000000000005'', current_setting(''t.reviewer'')'

set role app_staff;
select test.expect_ok(format('select * from api.reveal_contact(%s, %L, %L)', :'C', '30000000-0000-4000-8000-000000000001', '고객 요청 회신'),
  'P1 상담원: 배정된 리드 원문 조회');
select test.expect_error(format('select * from api.reveal_contact(%s, %L, %L)', :'C', '30000000-0000-4000-8000-000000000002', '확인'),
  '42501', 'P2 상담원: 다른 상담원 리드 조회 거부');
select test.expect_error(format('select * from api.reveal_contact(%s, %L, %L)', :'C', gen_random_uuid(), '확인'),
  '42501', 'P3 상담원: 임의 리드 ID → 같은 오류(존재 여부 비노출)');
select test.expect_error(format('select * from api.reveal_contact(%s, %L, %L)', :'R', '30000000-0000-4000-8000-000000000001', '확인'),
  '42501', 'P4 검수자: 원문 조회 거부');
select test.expect_error(format('select * from api.reveal_contact(%s, %L, %L)', :'C', '30000000-0000-4000-8000-000000000001', ' '),
  '22023', 'P5 사유 없는 원문 조회 거부');
select test.expect_eq(format('select count(*)::text from api.list_leads(%s, 50, 0)', :'C'), '1', 'P6 상담원 목록은 배정분만');
select test.expect_eq(format($q$select count(*)::text from api.list_leads(%s, 200, 0) where phone_masked !~ '^010-\*\*\*\*-[0-9]{4}$'$q$, :'O'),
  '0', 'P7 목록은 마스킹 번호만');
select test.expect_error(format('select * from api.export_leads_masked(%s, current_date - 1, current_date)', :'C'),
  '42501', 'P8 상담원 내려받기 거부');
select test.expect_ok(format('select * from api.export_leads_masked(%s, current_date - 1, current_date)', :'O'),
  'P9 대표 마스킹 내려받기');
select test.expect_error(format('select api.update_lead(%s, %L, %L, null)', :'C', '30000000-0000-4000-8000-000000000001', 'converted'),
  '22023', 'P10 허용되지 않은 상태 전이 거부');
select test.expect_ok(format('select api.update_lead(%s, %L, %L, %L)', :'C', '30000000-0000-4000-8000-000000000001', 'contacting', '1차 통화'),
  'P11 허용 상태 전이 + 메모');
select test.expect_error(format('select api.update_lead(%s, %L, %L, null)', :'C', '30000000-0000-4000-8000-000000000002', 'contacting'),
  '42501', 'P12 다른 상담원 리드 수정 거부');
select test.expect_error(format('select api.set_feature_flag(%s, %L, true, %L)', :'C', 'notify_live', '테스트'),
  '42501', 'P13 상담원 기능 스위치 변경 거부');
reset role;

select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'pii.reveal'$$, '1', 'P14 원문 조회 감사 기록 정확히 1건');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'lead.export'$$, '1', 'P15 내려받기 감사 기록');

-- 원문 조회 시간당 30건 제한
insert into core.audit_logs (actor_id, action, target_type)
select '00000000-0000-4000-8000-000000000002', 'pii.reveal', 'lead' from generate_series(1, 29);
set role app_staff;
select test.expect_error(format('select * from api.reveal_contact(%s, %L, %L)', :'C', '30000000-0000-4000-8000-000000000001', '확인'),
  '54000', 'P16 원문 조회 시간당 30건 초과 거부');
reset role;

-- 보유기간 만료 파기(예약 작업) + 대표의 수동 파기
select test.expect_eq('select core.purge_expired()::text', '1', 'P17 보유기간 지난 가상 고객 1건 자동 파기');
set role app_staff;
select test.expect_error('select core.purge_expired()', '42501', 'P18 앱 역할은 자동 파기 함수 실행 불가');
select test.expect_ok(format('select api.purge_customer(%s, %L, %L)', :'O', '30000000-0000-4000-8000-000000000002', '고객 삭제 요청'),
  'P19 대표 수동 파기');
select test.expect_error(format('select * from api.reveal_contact(%s, %L, %L)', :'O', '30000000-0000-4000-8000-000000000002', '확인'),
  '42501', 'P20 파기된 리드 원문 조회 불가');
reset role;
select test.expect_eq($$select count(*)::text from pii.customers where id in
  ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003')$$, '0', 'P21 파기 후 암호문 행 0');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'pii.purge'$$, '2', 'P22 파기 감사 기록 2건');
