-- 통화 녹취·STT·AI 요약·고객 이력 통합(0054~0057, PM 11/25 ①~④) 전체 흐름 시험. 가상 데이터·Mock만(외부 호출 없음).
\set ON_ERROR_STOP 1
reset role;

-- 작업자 역할도 시험 함수를 쓸 수 있게(시험 DB 전용)
grant usage on schema test to app_call;
grant execute on function test.expect_eq(text, text, text), test.expect_error(text, text, text),
  test.expect_error_msg(text, text, text, text), test.expect_ok(text, text) to app_call;

-- 가상 고객: A(리드 2건, 담당 상담원 서로 다름), B(리드 1건), 연락처 C는 리드 없음
insert into pii.customers (id, name_enc, phone_enc, phone_hmac, retention_until) values
  ('c0000000-0000-4000-8000-0000000000a1', 'v1:dummy', 'v1:dummy', repeat('ca', 32), now() + interval '90 days'),
  ('c0000000-0000-4000-8000-0000000000a2', 'v1:dummy', 'v1:dummy', repeat('ca', 32), now() + interval '90 days'),
  ('c0000000-0000-4000-8000-0000000000b1', 'v1:dummy', 'v1:dummy', repeat('cb', 32), now() + interval '90 days');
insert into core.leads (id, customer_id, name_masked, phone_last4, interest, assigned_to, idempotency_key, created_at) values
  ('c1000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', '통*고', '1111', 'internet_tv',
   '00000000-0000-4000-8000-000000000002', 'call-test-lead-000a1', now() - interval '30 days'),
  ('c1000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-0000000000a2', '통*고', '1111', 'internet_only',
   '00000000-0000-4000-8000-000000000004', 'call-test-lead-000a2', now() - interval '1 day'),
  ('c1000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000b1', '다*객', '2222', 'cctv_security',
   '00000000-0000-4000-8000-000000000002', 'call-test-lead-000b1', now() - interval '2 days');

-- 서버 서명 통화 수신 호출문
create function test.call_sql(p_id text, p_hmac text, p_notice text, p_path text, p_dur int default 90,
                              p_tamper_hmac text default null, p_ago int default 600) returns text
language plpgsql as $$
declare
  v_epoch bigint := floor(extract(epoch from now()))::bigint - p_ago;
  v_sha   text := case when p_path is null then null else repeat('d', 64) end;
  v_bytes text := case when p_path is null then null else '1000' end;
  v_kv    text := case when p_path is null then null else '1' end;
  tok text := test.token('lead', array['call-ingest', 'mock_tel', p_id, 'inbound', p_hmac, v_epoch::text, p_dur::text,
                                       p_notice, p_path, v_sha, v_bytes, v_kv, null]);
begin
  return format('select api.call_ingest(%L, %L, %L, %L, %L, %s::bigint, %s, %L, %L, %L, %L::int, %L, null::uuid)',
                tok, 'mock_tel', p_id, 'inbound', coalesce(p_tamper_hmac, p_hmac), v_epoch, p_dur, p_notice, p_path, v_sha, v_bytes, v_kv);
end $$;

-- 관리자 인자(행위자, 세션, 서명) 조각
create function test.cs(p_who text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'c2' then '00000000-0000-4000-8000-000000000002'
                       when 'c4' then '00000000-0000-4000-8000-000000000004' else '00000000-0000-4000-8000-000000000005' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'c2' then '10000000-0000-4000-8000-000000000002'
                       when 'c4' then '10000000-0000-4000-8000-000000000004' else '10000000-0000-4000-8000-000000000005' end;
begin
  return format('%L::uuid, %L::uuid, %L', a, s, test.staff_token(a, s));
end $$;
grant execute on function test.cs(text) to app_staff;

select set_config('t.ai_limit0', (select monthly_limit_krw::text from core.ai_budget_config where singleton), false);

-- ============ ① 녹취·저장 ============
select set_config('t.c_off',  test.call_sql('call-off-0001', repeat('ca', 32), 'rec-notice-v1', 'calls/00000000-0000-4000-8000-0000000c0001.bin'), false);
set role app_call;
select test.expect_eq(current_setting('t.c_off'), 'disabled', 'CR1 기본값(녹취 꺼짐): disabled, 파일 보관 안 함');
reset role;
select test.expect_eq($$select reason from core.call_object_deletions where storage_path = 'calls/00000000-0000-4000-8000-0000000c0001.bin'$$, 'disabled', 'CR1b 꺼짐 상태로 올라온 파일은 삭제 대기열');
select test.expect_eq($$select count(*)::text from pii.call_recordings r join core.calls c on c.id = r.call_id where c.provider_call_id = 'call-off-0001' and r.storage_path is null$$, '1', 'CR1c 통화 기록은 남고 파일 위치 없음');

set role app_staff;
select test.expect_error(format($$select api.call_settings_set(%s, '{"recording_enabled": true}', '켜기')$$, test.cs('c2')), '42501', 'CR2 상담원은 녹취 설정 불가');
select test.expect_error_msg(format($$select api.call_settings_set(%s, '{"recording_enabled": true}', '켜기')$$, test.cs('owner')), '22023', 'NOTICE_VERSION_REQUIRED', 'CR3 안내 문구 버전 없이 녹취 켜기 거부');
select test.expect_error_msg(format($$select api.call_settings_set(%s, '{"recording_enabled": true, "x": 1}', '켜기')$$, test.cs('owner')), '22023', 'INVALID_INPUT', 'CR3b 모르는 설정 키 거부');
select test.expect_error_msg(format($$select api.call_settings_set(%s, '{"retention_days": 0}', '보존')$$, test.cs('owner')), '22023', 'INVALID_INPUT', 'CR3c 보존 기간 범위 밖 거부');
select test.expect_error_msg(format($$select api.call_settings_set(%s, '{"recording_enabled": true, "notice_version": "rec-notice-v1"}', '')$$, test.cs('owner')), '22023', 'REASON_REQUIRED', 'CR3d 사유 없음 거부');
select test.expect_ok(format($$select api.call_settings_set(%s, '{"recording_enabled": true, "notice_version": "rec-notice-v1"}', '시험 켜기')$$, test.cs('owner')), 'CR4 대표: 안내 문구 버전과 함께 녹취 켜기');
reset role;

select set_config('t.c_nonotice', test.call_sql('call-nn-0001', repeat('ca', 32), 'rec-notice-v0', 'calls/00000000-0000-4000-8000-0000000c0002.bin'), false);
select set_config('t.c_ok',  test.call_sql('call-ok-0001', repeat('ca', 32), 'rec-notice-v1', 'calls/00000000-0000-4000-8000-0000000c0003.bin', 90), false);
select set_config('t.c_dup', test.call_sql('call-ok-0001', repeat('ca', 32), 'rec-notice-v1', 'calls/00000000-0000-4000-8000-0000000c0004.bin', 90), false);
select set_config('t.c_tamper', test.call_sql('call-tp-0001', repeat('ca', 32), 'rec-notice-v1', 'calls/00000000-0000-4000-8000-0000000c0005.bin', p_tamper_hmac => repeat('cb', 32)), false);
select set_config('t.c_badpath', test.call_sql('call-bp-0001', repeat('ca', 32), 'rec-notice-v1', '../etc/passwd'), false);
select set_config('t.c_unm', test.call_sql('call-un-0001', repeat('cc', 32), 'rec-notice-v1', 'calls/00000000-0000-4000-8000-0000000c0006.bin', 30), false);
select set_config('t.c_unm2', test.call_sql('call-un-0002', repeat('cd', 32), 'rec-notice-v1', 'calls/00000000-0000-4000-8000-0000000c0007.bin', 30), false);
set role app_call;
select test.expect_eq(current_setting('t.c_nonotice'), 'no_notice', 'CR5 안내 버전 불일치: no_notice(녹취 보관 안 함)');
select test.expect_eq(current_setting('t.c_ok'), 'stored', 'CR6 안내 재생 + 녹취 켜짐: stored');
select test.expect_eq(current_setting('t.c_dup'), 'exists', 'CR7 같은 통화 재전송: exists(중복 저장 없음)');
select test.expect_error(current_setting('t.c_tamper'), '42501', 'CR8 서명 후 연락처 해시 변조 거부');
select test.expect_error($$select api.call_ingest(null, 'mock_tel', 'call-ns-0001', 'inbound', repeat('ca', 32), 1800000000, 10, null, null, null, null, null, null)$$, '42501', 'CR9 서명 없는 호출 거부');
select test.expect_error(current_setting('t.c_badpath'), '22023', 'CR11 저장 경로 형식 오류 거부');
select test.expect_eq(current_setting('t.c_unm'), 'stored', 'CR12 리드 없는 연락처: 저장(미연결)');
select test.expect_eq(current_setting('t.c_unm2'), 'stored', 'CR12b 리드 없는 연락처 2');
select test.expect_error($$select * from core.calls$$, '42501', 'CR12c 작업자 역할은 통화 테이블 직접 조회 불가');
reset role;
set role app_public;
select test.expect_error(current_setting('t.c_ok'), '42501', 'CR10 공개 역할은 통화 수신 실행 불가');
reset role;
select id::text as call_ok from core.calls where provider_call_id = 'call-ok-0001' \gset
select id::text as call_un from core.calls where provider_call_id = 'call-un-0001' \gset
select id::text as call_un2 from core.calls where provider_call_id = 'call-un-0002' \gset
select id::text as call_nn from core.calls where provider_call_id = 'call-nn-0001' \gset
select test.expect_eq(format($$select lead_id::text || '|' || link_method || '|' || ambiguous::text from core.calls where id = %L$$, :'call_ok'),
  'c1000000-0000-4000-8000-0000000000a2|auto|true', 'CR6b 같은 연락처 최신 리드에 자동 연결, 리드 여러 건 표시');
select test.expect_eq(format($$select link_method from core.calls where id = %L$$, :'call_un'), 'unmatched', 'CR12d 미연결 표시');
select test.expect_eq($$select reason from core.call_object_deletions where storage_path = 'calls/00000000-0000-4000-8000-0000000c0004.bin'$$, 'duplicate', 'CR7b 재전송 파일은 삭제 대기열');
select test.expect_eq($$select reason from core.call_object_deletions where storage_path = 'calls/00000000-0000-4000-8000-0000000c0002.bin'$$, 'no_notice', 'CR5b 안내 없는 녹취 파일은 삭제 대기열');
select test.expect_eq($$select count(*)::text from core.call_jobs where kind = 'stt'$$, '3', 'CR6c 저장된 녹취만 변환 작업 자동 등록(3건)');

-- 열람
set role app_staff;
select test.expect_eq(format($$select storage_path from api.call_recording_access(%s, %L, '고객 요청 확인')$$, test.cs('c4'), :'call_ok'),
  'calls/00000000-0000-4000-8000-0000000c0003.bin', 'CR13 연결 리드 담당 상담원 열람');
select test.expect_error(format($$select * from api.call_recording_access(%s, %L, '확인')$$, test.cs('c2'), :'call_ok'), '42501', 'CR14 다른 리드 담당 상담원 열람 불가(같은 고객이어도)');
select test.expect_error(format($$select * from api.call_recording_access(%s, %L, '확인')$$, test.cs('c2'), :'call_un'), '42501', 'CR15 상담원은 미연결 통화 열람 불가');
select test.expect_ok(format($$select * from api.call_recording_access(%s, %L, '연결 확인')$$, test.cs('owner'), :'call_un'), 'CR15b 대표는 미연결 통화 열람');
select test.expect_error_msg(format($$select * from api.call_recording_access(%s, %L, ' ')$$, test.cs('owner'), :'call_ok'), '22023', 'REASON_REQUIRED', 'CR16 사유 없는 열람 거부');
select test.expect_error(format($$select * from api.call_recording_access(%s, %L, '확인')$$, test.cs('rv'), :'call_ok'), '42501', 'CR17 검토자는 녹취 열람 불가');
select test.expect_error(format($$select * from api.call_recording_access(%s, %L, '확인')$$, test.cs('owner'), :'call_nn'), '42501', 'CR17b 녹취 없는 통화 열람 불가');
-- 연결
select test.expect_error(format($$select api.call_link(%s, %L, %L, '연결')$$, test.cs('c2'), :'call_un', 'c1000000-0000-4000-8000-0000000000b1'), '42501', 'CR18 상담원은 고객 연결 불가');
select test.expect_error_msg(format($$select api.call_link(%s, %L, %L, '연결')$$, test.cs('owner'), :'call_un', 'c1000000-0000-4000-8000-0000000000b1'), '22023', 'REASON_REQUIRED', 'CR19 다른 연락처 리드 연결은 사유 5자 이상');
select test.expect_eq(format($$select api.call_link(%s, %L, %L, '가족 번호로 걸려온 통화 확인')$$, test.cs('owner'), :'call_un', 'c1000000-0000-4000-8000-0000000000b1'), 'manual_override', 'CR19b 사유와 함께 다른 연락처 연결(표시: manual_override)');
select test.expect_eq(format($$select api.call_link(%s, %L, %L, '이전 상담 건')$$, test.cs('owner'), :'call_ok', 'c1000000-0000-4000-8000-0000000000a1'), 'manual', 'CR20 같은 연락처 다른 리드로 연결(manual)');
select test.expect_error_msg(format($$select api.call_link(%s, %L, %L, '없는 리드')$$, test.cs('owner'), :'call_ok', 'c1000000-0000-4000-8000-0000000000ff'), '22023', 'INVALID_LEAD', 'CR20b 없는 리드 연결 거부');
reset role;
select test.expect_eq($$select count(*)::text from core.call_links$$, '2', 'CR21 연결 변경 이력 2건');
select test.expect_error($$update core.call_links set reason = 'x'$$, '42501', 'CR21b 연결 이력 수정 불가');
select test.expect_error(format($$delete from core.calls where id = %L$$, :'call_ok'), '42501', 'CR21c 통화 기록 삭제 불가');
select test.expect_error(format($$update core.calls set duration_sec = 1 where id = %L$$, :'call_ok'), '42501', 'CR21d 통화 기본 정보 변경 불가');

-- ============ ② STT ============
set role app_call;
select test.expect_eq($$select count(*)::text from api.call_stt_claim()$$, '0', 'ST1 변환 꺼짐: 작업 안 가져감(외부 호출 0)');
reset role;
set role app_staff;
select test.expect_ok(format($$select api.call_settings_set(%s, '{"stt_enabled": true}', '변환 시험')$$, test.cs('owner')), 'ST2a 변환 켜기(단가·한도 0)');
reset role;
set role app_call;
select test.expect_eq($$select count(*)::text from api.call_stt_claim()$$, '0', 'ST2 단가·월 한도 0원: 작업 안 가져감');
reset role;
set role app_staff;
select test.expect_ok(format($$select api.call_settings_set(%s, '{"stt_price_per_min_krw": 50, "stt_monthly_cap_krw": 100}', '시험 한도')$$, test.cs('owner')), 'ST3a 분당 50원·월 100원');
reset role;
set role app_call;
select job_id as j1, lease_token as l1, call_id as j1call, reserved_krw as j1cost from api.call_stt_claim() \gset
select test.expect_eq(format('select %L', :'j1cost'), '100', 'ST3 90초 통화 = 2분 × 50원 예약');
select test.expect_eq($$select count(*)::text from api.call_stt_claim()$$, '0', 'ST4 월 한도(100원) 초과 예상: 다음 작업 안 가져감');
select test.expect_eq(format($$select api.call_stt_complete(%s, gen_random_uuid(), 'v1:enc', '안녕하세요', 'mock_stt', 0)$$, :'j1'), 'stale', 'ST5 잠금 토큰 다르면 stale');
select test.expect_error_msg(format($$select api.call_stt_complete(%s, %L, 'v1:enc', '번호는 010-1234-5678 입니다', 'mock_stt', 90)$$, :'j1', :'l1'), '22023', 'UNMASKED_PII', 'ST6 가린 글에 전화번호 남으면 거부');
select test.expect_eq(format($$select api.call_job_fail(%s, %L, 'PROVIDER_TIMEOUT', true, 0)$$, :'j1', :'l1'), 'retry', 'ST7 일시 오류: 재시도 대기');
select test.expect_eq(format($$select api.call_job_fail(%s, %L, 'PROVIDER_TIMEOUT', true, 0)$$, :'j1', :'l1'), 'stale', 'ST7b 같은 실패 재전송: stale(횟수 중복 없음)');
reset role;
select test.expect_eq(format($$select attempts::text || status from core.call_jobs where id = %s$$, :'j1'), '1queued', 'ST7c 실패 1회 기록');
-- 첫 작업만 즉시 재시도 가능하게(대기 시간 경과 흉내)
update core.call_jobs set next_attempt_at = now() - interval '1 second' where id = :'j1';
set role app_call;
select job_id as j1b, lease_token as l1b from api.call_stt_claim() \gset
select test.expect_eq(format('select %L', :'j1b'), :'j1', 'ST8 실패(청구 0원) 뒤 같은 작업 다시 가져감');
select test.expect_eq(format($$select api.call_stt_complete(%s, %L, 'v1:enc-full', '[이름] 고객: 인터넷 티비 같이 신청하고 싶어요. 내일 오후 3시에 다시 전화 주세요.', 'mock_stt', 90)$$, :'j1b', :'l1b'), 'done', 'ST9 변환 완료');
select test.expect_eq(format($$select api.call_stt_complete(%s, %L, 'v1:enc-full', '다시', 'mock_stt', 90)$$, :'j1b', :'l1b'), 'stale', 'ST10 완료 재전송: stale(중복 저장 없음)');
reset role;
select test.expect_eq(format($$select count(*)::text from pii.call_transcripts where call_id = %L$$, :'j1call'), '1', 'ST10b 변환문 1건');
select test.expect_eq(format($$select status from core.call_jobs where call_id = %L and kind = 'summary'$$, :'j1call'), 'queued', 'ST11 변환 완료 시 요약 작업 자동 등록');
select test.expect_eq(format($$select actual_krw::text from core.call_stt_ledger where job_id = %s and attempt = 1$$, :'j1'), '90', 'ST12 실제 비용 확정');
-- 잠금 만료 → 실패 1회로 회수, 3회째 dead
update core.call_settings set stt_monthly_cap_krw = 100000;
set role app_call;
select job_id as j2, lease_token as l2 from api.call_stt_claim() \gset
reset role;
update core.call_jobs set lease_until = now() - interval '1 second' where id = :'j2';
set role app_call;
select test.expect_eq(format($$select api.call_stt_complete(%s, %L, 'v1:x', '늦은 완료', 'mock_stt', 0)$$, :'j2', :'l2'), 'stale', 'ST13 잠금 만료 뒤 늦은 완료: stale');
select test.expect_eq($$select count(*)::text from api.call_stt_claim()$$, '1', 'ST13b 다음 가져가기: 만료 작업 회수 후 다른 대기 작업 가져감');
reset role;
select test.expect_eq(format($$select attempts::text || status || last_error from core.call_jobs where id = %s$$, :'j2'), '1queuedLEASE_EXPIRED', 'ST14 잠금 만료 = 실패 1회');
select test.expect_eq(format($$select (actual_krw = reserved_krw)::text from core.call_stt_ledger where job_id = %s and attempt = 0$$, :'j2'), 'true', 'ST14b 만료 작업 비용은 예약액으로 보수 확정');
update core.call_jobs set attempts = 2, next_attempt_at = now() - interval '1 second' where id = :'j2';
set role app_call;
select job_id as j2b, lease_token as l2b from api.call_stt_claim() \gset
select test.expect_eq(format($$select api.call_job_fail(%s, %L, 'PROVIDER_5XX', true, 0)$$, :'j2b', :'l2b'), 'dead', 'ST15 3회 실패: dead(무한 재시도 없음)');
reset role;
select call_id::text as j2call from core.call_jobs where id = :'j2' \gset
select set_config('t.used', core.call_stt_month_used(to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'))::text || '/100000', false);
set role app_staff;
select test.expect_error(format($$select api.call_job_requeue(%s, %L, 'stt', '재시도')$$, test.cs('c2'), :'call_un2'), '42501', 'ST16 상담원은 재처리 불가');
select test.expect_ok(format($$select api.call_job_requeue(%s, %L, 'stt', '장애 복구 후 재처리')$$, test.cs('owner'), :'j2call'), 'ST17 대표 재처리(dead → queued)');
select test.expect_eq(format($$select used_krw::text || '/' || cap_krw::text from api.call_stt_status(%s)$$, test.cs('rv')), current_setting('t.used'), 'ST18 검토자: 사용액/한도 조회');
reset role;

-- ============ ③ AI 요약 ============
update core.ai_budget_config set monthly_limit_krw = 100000 where singleton;
select api.ai_budget_hold(5) as r1 \gset
select api.ai_budget_hold(5) as r2 \gset
set role app_call;
select test.expect_error_msg($$select * from api.call_summary_claim(999999999)$$, '22023', 'INVALID_RESERVATION', 'SM1 없는 AI 비용 예약 거부');
select test.expect_eq(format($$select count(*)::text from api.call_summary_claim(%s)$$, :'r1'), '0', 'SM2 요약 꺼짐: 안 가져감');
reset role;
set role app_staff;
select test.expect_ok(format($$select api.call_settings_set(%s, '{"summary_enabled": true}', '요약 시험')$$, test.cs('owner')), 'SM3a 요약 켜기');
reset role;
set role app_call;
select job_id as s1, lease_token as sl1, transcript_masked as st1 from api.call_summary_claim(:'r1') \gset
select test.expect_eq(format('select %L', :'st1'), '[이름] 고객: 인터넷 티비 같이 신청하고 싶어요. 내일 오후 3시에 다시 전화 주세요.', 'SM3 AI 입력은 가린 변환문');
select test.expect_error_msg(format($$select * from api.call_summary_claim(%s)$$, :'r1'), '22023', 'INVALID_RESERVATION', 'SM4 같은 AI 예약 재사용 거부');
select test.expect_error_msg(format($$select api.call_summary_complete(%s, %L, 'internet_tv', 'unknown', null, '인터넷 TV 문의', '{}')$$, :'s1', :'sl1'), '22023', 'UNSUPPORTED_CLAIM', 'SM5 근거 없는 상품 분류 거부(추측 금지)');
select test.expect_error_msg(format($$select api.call_summary_complete(%s, %L, 'internet_tv', 'unknown', null, '인터넷 TV 문의', '{"product": "인터넷 TV 3년 약정"}')$$, :'s1', :'sl1'), '22023', 'UNSUPPORTED_CLAIM', 'SM6 변환문에 없는 근거 거부');
select test.expect_error_msg(format($$select api.call_summary_complete(%s, %L, 'unknown', 'unknown', null, '문의', '{"product": "인터넷 티비"}')$$, :'s1', :'sl1'), '22023', 'UNSUPPORTED_CLAIM', 'SM7 근거와 값 불일치 거부');
select test.expect_error_msg(format($$select api.call_summary_complete(%s, %L, 'unknown', 'unknown', null, '연락처 010 1234 5678', '{}')$$, :'s1', :'sl1'), '22023', 'UNMASKED_PII', 'SM8 요약에 전화번호 남으면 거부');
select test.expect_eq(format($$select api.call_summary_complete(%s, %L, 'internet_tv', 'callback_requested', %s, '인터넷+TV 신청 희망, 내일 오후 재연락 요청', '{"product": "인터넷 티비 같이 신청하고 싶어요", "outcome": "다시 전화 주세요", "callback": "내일 오후 3시에 다시 전화"}')$$,
  :'s1', :'sl1', floor(extract(epoch from now() + interval '1 day'))::bigint), 'done', 'SM9 근거 있는 분류 저장');
select test.expect_eq(format($$select api.call_summary_complete(%s, %L, 'unknown', 'unknown', null, '다시', '{}')$$, :'s1', :'sl1'), 'stale', 'SM10 완료 재전송: stale');
reset role;
select test.expect_eq(format($$select version::text || source || product || outcome from core.call_summaries where call_id = %L$$, :'j1call'), '1aiinternet_tvcallback_requested', 'SM11 AI 1판 저장');
-- 관리자 수정: call_ok는 리드 a1(상담원 c2 담당)으로 연결됨
set role app_staff;
select test.expect_eq(format($$select api.call_summary_edit(%s, %L, 'internet_tv', 'applied', %s, '현장 확인 후 신청 완료', '고객 통화로 신청 확정')$$, test.cs('c2'), :'call_ok', floor(extract(epoch from now() + interval '1 day'))::bigint)::text, '2', 'SM12 담당 상담원 수정 → 2판');
select test.expect_error(format($$select api.call_summary_edit(%s, %L, 'other', 'declined', null, '수정', '시도')$$, test.cs('c4'), :'call_ok'), '42501', 'SM13 담당 아닌 상담원 수정 불가');
select test.expect_error(format($$select api.call_summary_edit(%s, %L, 'other', 'declined', null, '수정', '시도')$$, test.cs('rv'), :'call_ok'), '42501', 'SM14 검토자 수정 불가');
select test.expect_error_msg(format($$select api.call_summary_edit(%s, %L, 'other', 'declined', null, '수정', '')$$, test.cs('c2'), :'call_ok'), '22023', 'REASON_REQUIRED', 'SM15 수정 사유 필수');
select test.expect_error_msg(format($$select api.call_summary_edit(%s, %L, 'tv_plus', 'declined', null, '수정', '시도')$$, test.cs('c2'), :'call_ok'), '22023', 'INVALID_INPUT', 'SM16 목록 밖 상품 거부');
select test.expect_eq(format($$select count(*)::text from api.call_summary_versions(%s, %L)$$, test.cs('c2'), :'call_ok'), '2', 'SM17 판 목록 2건(원본 AI 판 보존)');
reset role;
select test.expect_error($$update core.call_summaries set product = 'other'$$, '42501', 'SM18 요약 기록 직접 수정 불가(추가 전용)');
select test.expect_error($$delete from core.call_summaries$$, '42501', 'SM18b 요약 기록 삭제 불가');

-- ============ ④ 고객 이력 통합 ============
set role app_staff;
select test.expect_eq(format($$select string_agg(kind, ',' order by kind) from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a1', current_date - 60, current_date + 2)$$, test.cs('c2')),
  'call,callback_due,lead_created', 'TL1 상담원(리드 a1 담당): 자기 리드 기록만(같은 고객의 다른 담당 리드 a2 제외)');
select test.expect_error(format($$select * from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a1', current_date - 60, current_date)$$, test.cs('c4')), '42501', 'TL2 담당 아닌 리드 이력 열람 불가');
select test.expect_eq(format($$select count(*)::text from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a2', current_date - 60, current_date + 2) where ref = %L or kind = 'callback_due'$$, test.cs('c4'), :'call_ok'),
  '0', 'TL3 리드 a2 담당: 다른 리드로 옮겨진 통화·재연락은 안 보임');
select test.expect_eq(format($$select string_agg(kind, ',' order by kind) from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a2', current_date - 60, current_date + 2)$$, test.cs('c4')),
  'call,call,lead_created', 'TL3b 리드 a2 담당: a2에 연결된 통화 2건(녹취 꺼짐·안내 없음)과 리드만');
select test.expect_eq(format($$select count(*)::text from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a2', current_date - 60, current_date + 2) where kind = 'lead_created'$$, test.cs('owner')),
  '2', 'TL4 대표: 같은 고객(연락처) 리드 2건 통합');
select test.expect_error_msg(format($$select * from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a1', current_date - 400, current_date)$$, test.cs('owner')), '22023', 'INVALID_RANGE', 'TL5 기간 366일 초과 거부');
select test.expect_eq(format($$select count(*)::text from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a1', current_date - 60, current_date + 2)
   where detail::text ~ '[0-9a-f]{64}' or detail::text like '%%calls/%%' or detail::text like '%%v1:%%' or detail::text ~ '010-?[0-9]{4}'$$, test.cs('owner')), '0', 'TL6 이력에 연락처 해시·녹취 위치·암호문·전화번호 없음');
select test.expect_eq(format($$select detail->'summary'->>'version' from api.customer_history(%s, 'c1000000-0000-4000-8000-0000000000a1', current_date - 60, current_date + 2) where kind = 'call'$$, test.cs('c2')),
  '2', 'TL7 통화 이력은 최신 요약 판(관리자 수정) 표시');
select test.expect_eq(format($$select count(*)::text from api.timeline_by_date(%s, current_date - 1, current_date + 2) where kind = 'call_unmatched'$$, test.cs('owner')), '1', 'TL8 대표 날짜별 조회: 미연결 통화 표시');
select test.expect_eq(format($$select count(*)::text from api.timeline_by_date(%s, current_date - 1, current_date + 2) where kind = 'call_unmatched'$$, test.cs('c2')), '0', 'TL9 상담원 날짜별 조회: 미연결 통화 없음');
select test.expect_eq(format($$select count(*)::text from api.timeline_by_date(%s, current_date - 1, current_date + 2) where lead_id = 'c1000000-0000-4000-8000-0000000000a2'$$, test.cs('c2')), '0', 'TL10 상담원 날짜별 조회: 남의 담당 리드 제외');
select test.expect_eq(format($$select count(*)::text from api.timeline_by_date(%s, (now() at time zone 'Asia/Seoul')::date + 1, (now() at time zone 'Asia/Seoul')::date + 1) where kind = 'callback_due'$$, test.cs('c2')), '1', 'TL11 내일 재연락 일정 조회');
select test.expect_error_msg(format($$select * from api.timeline_by_date(%s, current_date - 40, current_date)$$, test.cs('owner')), '22023', 'INVALID_RANGE', 'TL12 날짜별 31일 초과 거부');
reset role;
set role app_public;
select test.expect_error($$select * from api.customer_history(null, null, null, null, current_date, current_date)$$, '42501', 'TL13 공개 역할 이력 조회 불가');
reset role;
set role app_call;
select test.expect_error($$select * from api.timeline_by_date(null, null, null, current_date, current_date)$$, '42501', 'TL14 작업자 역할 이력 조회 불가');
select test.expect_error($$select * from api.call_settings_get(null, null, null)$$, '42501', 'TL15 작업자 역할 관리자 함수 불가');
reset role;
set role app_staff;
select test.expect_error($$select * from api.call_stt_claim()$$, '42501', 'TL16 관리자 역할은 작업자 함수 불가');
reset role;

-- ============ 삭제·보존 ============
set role app_staff;
select test.expect_error(format($$select api.call_recording_delete(%s, %L, '고객 삭제 요청')$$, test.cs('c2'), :'call_ok'), '42501', 'DL1 상담원 녹취 삭제 불가');
select test.expect_error_msg(format($$select api.call_recording_delete(%s, %L, '요청')$$, test.cs('owner'), :'call_ok'), '22023', 'REASON_REQUIRED', 'DL2 삭제 사유 5자 이상');
select test.expect_ok(format($$select api.call_recording_delete(%s, %L, '고객 삭제 요청 처리')$$, test.cs('owner'), :'call_ok'), 'DL3 대표 녹취 삭제');
select test.expect_error(format($$select * from api.call_recording_access(%s, %L, '확인')$$, test.cs('owner'), :'call_ok'), '42501', 'DL4 삭제 뒤 열람 불가');
reset role;
select test.expect_eq(format($$select count(*)::text from pii.call_recordings where call_id = %L$$, :'call_ok'), '0', 'DL5 연락처 해시·위치 행 삭제');
select test.expect_eq(format($$select count(*)::text from pii.call_transcripts where call_id = %L$$, :'call_ok'), '0', 'DL6 변환문 함께 삭제');
select test.expect_eq(format($$select string_agg(distinct summary_masked, ',') from core.call_summaries where call_id = %L$$, :'call_ok'), '[삭제됨]', 'DL7 요약 본문 지움(분류만 남음)');
select test.expect_eq($$select count(*)::text from core.call_object_deletions where storage_path = 'calls/00000000-0000-4000-8000-0000000c0003.bin' and reason = 'purge'$$, '1', 'DL8 파일 삭제 대기열');
set role app_call;
select test.expect_eq($$select api.call_object_deletion_done('calls/00000000-0000-4000-8000-0000000c0003.bin')::text$$, 'true', 'DL9 저장소 삭제 완료 기록');
select test.expect_error_msg($$select api.call_object_deletion_done('calls/00000000-0000-4000-8000-0000000c0006.bin')$$, '42501', 'STILL_REFERENCED', 'DL10 살아 있는 녹취 파일은 삭제 완료로 기록 불가');
reset role;
-- 보존 기한 만료
update pii.call_recordings set retention_until = now() - interval '1 second' where call_id = :'call_un2';
select test.expect_eq($$select core.purge_expired_calls()::text$$, '1', 'DL11 보존 기한 지난 녹취 1건 삭제');
select test.expect_eq(format($$select recording_state || '|' || (select status from core.call_jobs j where j.call_id = %L and j.kind = 'stt') from core.calls where id = %L$$, :'call_un2', :'call_un2'), 'deleted|cancelled', 'DL12 만료 삭제 시 남은 작업 취소');
-- 리드 파기 시 연결된 녹취도 삭제(call_un → 리드 b1)
set role app_staff;
select test.expect_ok(format($$select api.purge_customer(%s, 'c1000000-0000-4000-8000-0000000000b1', '고객 파기 요청 처리')$$, test.cs('owner')), 'DL13 대표 고객 파기');
reset role;
select test.expect_eq(format($$select recording_state from core.calls where id = %L$$, :'call_un'), 'deleted', 'DL14 파기된 리드의 통화 녹취도 삭제');
select test.expect_eq($$select count(*)::text from core.audit_logs where action like 'call.%' and (detail::text ~ '[0-9a-f]{64}' or detail::text like '%calls/%' or detail::text like '%v1:%')$$, '0', 'DL15 감사 기록에 연락처 해시·파일 위치·암호문 없음');

-- 정리: 이 시험이 바꾼 AI 한도·통화 설정 되돌리기
update core.ai_budget_config set monthly_limit_krw = current_setting('t.ai_limit0')::int where singleton;
update core.call_settings set recording_enabled = false, stt_enabled = false, summary_enabled = false, stt_monthly_cap_krw = 0, stt_price_per_min_krw = 0;
