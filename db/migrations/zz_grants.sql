-- zz_grants.sql — 모든 마이그레이션 뒤에 매번 실행하는 멱등 권한 스크립트
-- REV-004 SEC-03: 공개/관리자 분리, SECURITY DEFINER 실행 권한 허용 목록
begin;

grant fideon_api to current_user;    -- 함수 소유자 변경을 위해 필요

-- 1) PUBLIC 및 Supabase 기본 역할, 앱 역할에서 전부 회수
do $$
declare
  r text;
begin
  foreach r in array array['public', 'anon', 'authenticated', 'app_public', 'app_staff', 'app_server', 'app_ai', 'app_ad_monitor', 'app_ad_scheduler', 'app_call'] loop
    if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema core, pii, security, api from %s', r);
      execute format('revoke all on all tables in schema core, pii, security from %s', r);
      execute format('revoke all on all sequences in schema core, pii, security from %s', r);
      execute format('revoke all on all functions in schema core, pii, security, api from %s', r);
    end if;
  end loop;
end
$$;

-- 2) 앞으로 만들 객체의 기본 권한
alter default privileges in schema core, pii, security, api revoke all on tables from public;
alter default privileges in schema core, pii, security, api revoke execute on functions from public;
alter default privileges in schema core, pii, security revoke all on sequences from public;

-- 3) 스키마 USAGE
grant usage on schema api to app_public, app_staff, app_ai;
do $$ begin if exists (select 1 from pg_roles where rolname = 'app_ad_monitor') then execute 'grant usage on schema api to app_ad_monitor'; end if; end $$;  -- 0021 정기 감시 전용
do $$ begin if exists (select 1 from pg_roles where rolname = 'app_ad_scheduler') then execute 'grant usage on schema api to app_ad_scheduler'; end if; end $$;  -- 0035 예약 실행 전용
do $$ begin if exists (select 1 from pg_roles where rolname = 'app_call') then execute 'grant usage on schema api to app_call'; end if; end $$;  -- 0050 통화 수신·변환 작업 전용
grant usage on schema core, pii, security, api, extensions to fideon_api;
grant create on schema api to fideon_api;

-- 4) 테이블 권한: fideon_api만. security.server_keys는 제외(서명 검증 함수만 읽음)
grant select, insert, update on all tables in schema core to fideon_api;
grant select, insert, update, delete on all tables in schema pii to fideon_api;
grant select, insert, update on security.staff_sessions to fideon_api;
grant usage on all sequences in schema core, pii to fideon_api;
revoke update, delete on core.audit_logs from fideon_api;          -- 감사 로그는 추가 전용
grant delete on core.lead_notes to fideon_api;   -- 0063: 파기 시 상담 메모 삭제(api.purge_* 안에서만)
revoke all on security.server_keys from fideon_api;

-- 5) RLS: core·pii·security 모든 테이블 enable + force, 허용 정책은 fideon_api만
do $$
declare
  r record;
begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('core', 'pii', 'security') loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
    execute format('alter table %I.%I force row level security', r.schemaname, r.tablename);
    execute format('drop policy if exists fideon_api_all on %I.%I', r.schemaname, r.tablename);
    if not (r.schemaname = 'security' and r.tablename = 'server_keys') then
      execute format('create policy fideon_api_all on %I.%I to fideon_api using (true) with check (true)',
                     r.schemaname, r.tablename);
    end if;
  end loop;
  -- 서명 키는 마이그레이션 실행 역할(= security.verify_token 소유자)만 읽는다.
  -- Supabase의 postgres 역할이 RLS 우회 속성이 없어도 동작하도록 명시 정책을 둔다.
  execute 'drop policy if exists key_reader on security.server_keys';
  execute format('create policy key_reader on security.server_keys for select to %I using (true)', current_user);
end
$$;

-- 6) api 함수 소유자 = fideon_api. security.* 함수는 마이그레이션 실행 역할 소유 유지
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
  loop
    execute format('alter function %s owner to fideon_api', f.sig);
  end loop;
end
$$;

-- 7) 함수 실행 권한 (허용 목록 — tests/db/10_grants.sql이 이 목록과 실제 상태를 대조)
grant execute on function
  security.assert_staff(uuid, uuid, text, text[]),
  security.verify_token(text, text, text[]),
  core.purge_customer_internal(uuid, uuid, text),
  core.purge_lead_internal(uuid, uuid, text),   -- 0062: 신청 1건 파기(api 함수 소유자만)
  core.legal_hold(uuid),   -- 0063: 계약 완료 5년 보존 판정
  core.policy_terms_shape(jsonb),   -- 0008: terms 형태 검사(check 제약이 쓴다)
  core.recontact_allowed(uuid, text)   -- 0060: 재연락 가능 판정(api 함수 소유자만 실행)
  to fideon_api;

grant execute on function
  api.create_lead(text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text),
  api.policy_published(),
  api.consult_event_record(text, text),   -- 0012: 상담 시작 건수(개인정보 없음)
  api.notice_intake_gate(text, jsonb),    -- 0016: 접수 직전 고지 승인 게이트(문구·개인정보 없이 오류 코드만)
  api.policy_intake_gate(text, text, text),  -- 0025·0026: 접수 직전 정책 상태 잠금·게시 스위치·유효 정책 게이트(오류 코드만)
  api.application_save(text, text, text, text),  -- 0017: 서버 서명이 있어야 저장되는 암호화 신청서
  api.lead_gclid_attach(text, text, text, text),  -- 0027: 서버 서명이 있어야 기록되는 광고 클릭 식별값(gclid) 귀속
  api.followup_request(text, text, text, text),  -- 0023: 서버 서명이 있어야 기록되는 대표 직접 연락 동의
  api.consult_rate_hit(text, text),  -- 0024: 상담 채팅 공용 횟수 제한(IP HMAC만)
  api.application_amend(text, text, text, text, text, text),  -- 0019: 같은 연락처 재접수의 변경 요청(서버 서명·암호화 본문)
  api.marketing_opt_out(text, text, text)  -- 0060: 서버 서명이 있어야 기록되는 수신 거부
  to app_public;

grant execute on function
  api.staff_session_open(uuid, uuid, text),
  api.staff_session_revoke(uuid, uuid, text),
  api.whoami(uuid, uuid, text),
  api.list_leads(uuid, uuid, text, int, int),
  api.reveal_contact(uuid, uuid, text, uuid, text),
  api.update_lead(uuid, uuid, text, uuid, text, text),
  api.assign_lead(uuid, uuid, text, uuid, uuid),
  api.export_leads_masked(uuid, uuid, text, date, date),
  api.set_feature_flag(uuid, uuid, text, text, boolean, text),
  api.purge_customer(uuid, uuid, text, uuid, text),
  api.policy_create_draft(uuid, uuid, text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, jsonb),
  api.policy_submit(uuid, uuid, text, uuid),
  api.policy_approve(uuid, uuid, text, uuid, text, jsonb),
  api.policy_reject(uuid, uuid, text, uuid, text),
  api.policy_list(uuid, uuid, text, int, int),
  api.ad_budget_approve(uuid, uuid, text, text, int, int, timestamptz, text),
  api.ad_budget_revoke(uuid, uuid, text, text, text),
  api.ad_spend_request(uuid, uuid, text, text, int, text),
  api.ad_budget_overview(uuid, uuid, text, int),
  api.ad_performance_record(uuid, uuid, text, text, date, int, int, int, text),
  api.ad_funnel(uuid, uuid, text, date, date),
  api.ad_alert_open(uuid, uuid, text, text, jsonb),
  api.ad_alert_resolve(uuid, uuid, text, uuid, text),
  api.ad_alert_list(uuid, uuid, text, int),
  api.ai_budget_limit_get(uuid, uuid, text),
  api.ai_budget_limit_set(uuid, uuid, text, int, text),
  api.ai_budget_limits_set(uuid, uuid, text, int, int, int, int, text),   -- 0028: 일·사용자 한도(대표만)
  api.ai_budget_pause_set(uuid, uuid, text, boolean, text),   -- 0028: 긴급 차단(대표만)
  api.ai_budget_adjust(uuid, uuid, text, bigint, int, text),   -- 0028: 불확실 정산 조정(대표만)
  api.policy_publish_get(uuid, uuid, text),
  api.policy_publish_set(uuid, uuid, text, boolean, text),
  api.notice_text_list(uuid, uuid, text),
  api.notice_text_add(uuid, uuid, text, text, text, text, text),
  api.notice_review_add(uuid, uuid, text, text, jsonb, text, text),
  api.notice_review_list(uuid, uuid, text),
  api.dealer_packet_get(uuid, uuid, text, uuid, text),
  api.dealer_packet_status(uuid, uuid, text, uuid),
  api.handoff_record(uuid, uuid, text, uuid, text, text),
  api.handoff_list(uuid, uuid, text, uuid),
  api.ad_launch_begin(uuid, uuid, text, text, text, int),
  api.ad_launch_finish(uuid, uuid, text, text, text, text, text),
  api.ad_launch_active(uuid, uuid, text, text),
  api.ad_launch_paused(uuid, uuid, text, text),
  api.ad_launch_resolve(uuid, uuid, text, text, text, text, text),
  api.application_amendments(uuid, uuid, text, uuid),   -- 0019: 변경 요청 열람(대표, 방금 열람한 경우만)
  api.ad_spend_request_window(uuid, uuid, text, text, int, text),   -- 0021: 집행 기간·날짜별 최대 청구액 판정
  api.followup_list(uuid, uuid, text),   -- 0023: 대표 후속 연락 목록(대표만)
  api.followup_done(uuid, uuid, text, uuid),
  api.ad_monthly_budget_set(uuid, uuid, text, int, int, text),   -- 0034: 광고 월 예산 설정(대표만, 사유·감사)
  api.ad_monthly_budget_get(uuid, uuid, text),   -- 0034: 광고 월 예산·이번 달 사용액 조회(대표·검토자)
  api.ad_cpc_policy_set(uuid, uuid, text, int, text),   -- 0035: CPC 정책(대표만)
  api.ad_keyword_approve(uuid, uuid, text, text, text),   -- 0035: PM 승인 키워드 등록(대표만, EXACT)
  api.ad_keyword_revoke(uuid, uuid, text, text, text),   -- 0035: 키워드 철회 → 예약 취소·활성 캠페인 승인 철회
  api.ad_enable_schedule(uuid, uuid, text, text, text, timestamptz, text[], text, int, text),   -- 0035: 활성화 예약(대표만)
  api.ad_enable_cancel(uuid, uuid, text, text, text),   -- 0035: 활성화 예약 취소(대표만)
  api.recontact_schedule(uuid, uuid, text, uuid, date, text),   -- 0060: 날짜별 재연락 일정(대표만)
  api.recontact_due(uuid, uuid, text),
  api.recontact_close(uuid, uuid, text, bigint, text),
  api.recontact_sweep(uuid, uuid, text),
  api.crm_unhandled(uuid, uuid, text),   -- 0061: 미처리 자동 분류
  api.purge_lead(uuid, uuid, text, uuid, text),   -- 0062: 신청 1건 파기(대표만)
  api.contract_schedule(uuid, uuid, text, uuid, text, date, int, int),   -- 0069: 설치 일정(대표만)
  api.contract_status(uuid, uuid, text, uuid, text, date),   -- 0069: 설치 완료·취소·해지 → 환수 위험 판정
  api.settlement_record(uuid, uuid, text, uuid, text, int, date),   -- 0069: 정산 원장(추가 전용)
  api.contract_list(uuid, uuid, text, text)   -- 0069: 설치·정산·환수 목록(대표만)
  to app_staff;

-- 0021 계정 합산·집행 종료일 보조 함수: api 함수 소유자(fideon_api)만 실행
grant execute on function core.ad_account_day(date), core.ad_account_total(), core.ad_window_end(date, timestamptz) to fideon_api;
grant execute on function core.ad_account_month(date), core.ad_month_effective_limit(), core.ad_month_check(date, date, int) to fideon_api;  -- 0034 월 예산 보조
grant execute on function core.ad_enable_check(text, text, text[], int, timestamptz) to fideon_api;  -- 0035 활성화 판정 보조
-- 0035 예약 실행: 전용 역할 app_ad_scheduler만(예약 잡기·최종 판정·결과 기록 + 중지 기록, 테이블 권한 없음)
grant execute on function api.ad_sched_claim(uuid), api.ad_sched_gate(uuid, uuid), api.ad_sched_finish(uuid, uuid, text, text), api.ad_monitor_stop(text, text, boolean) to app_ad_scheduler;
-- 0021 광고 정기 감시: 전용 역할 app_ad_monitor만(대상 조회·중지·실행 기록 3개, 테이블 권한 없음)
grant execute on function api.ad_monitor_targets(), api.ad_monitor_stop(text, text, boolean), api.ad_monitor_record(boolean, jsonb), api.ad_monitor_begin(uuid) to app_ad_monitor;  -- 0022: 중복 실행 방지

-- 0011 AI 사용료 예약: 전용 역할 app_ai만(app_public 아님, REV-004 SEC-04)
grant execute on function api.ai_budget_hold(int, text, text), api.ai_budget_hold(int, text, text, text), api.ai_budget_confirm(bigint, int), api.ai_budget_release(bigint), api.ai_budget_uncertain(bigint), api.ai_budget_uncertain(bigint, int) to app_ai;  -- 0028: 한도 4종·멱등 예약, 불확실 정산 / 0033: 불확실 정산 금액 지정
grant execute on function core.ai_spent(text, date, text) to fideon_api;  -- 0028: 사용액 계산 보조(api 함수 소유자만)
grant execute on function api.ad_funnel_full(uuid, uuid, text, date, date) to app_staff;

-- 0064~0067 통화 녹취·STT·요약·이력: api 함수 소유자가 쓰는 내부 보조 함수
grant execute on function core.call_purge_internal(uuid, uuid, text), core.call_visible(core.staff, uuid),
  core.call_text_unmasked(text), core.call_jobs_reclaim(text), core.call_stt_month_used(text),
  core.call_summary_check(text, text, timestamptz, text), core.call_evidence_ok(text, text, text),
  core.timeline_leads(core.staff, uuid), core.timeline_events(uuid[], timestamptz, timestamptz) to fideon_api;
-- 통화 작업자 전용 역할 app_call: 수신·변환·요약 작업·저장소 삭제 대기열만(테이블 권한 없음, 관리자 함수 없음)
grant execute on function
  api.call_ingest(text, text, text, text, text, bigint, int, text, text, text, int, text, uuid),
  api.call_stt_claim(), api.call_stt_complete(bigint, uuid, text, text, text, int),
  api.call_job_fail(bigint, uuid, text, boolean, int),
  api.call_summary_claim(bigint), api.call_summary_complete(bigint, uuid, text, text, bigint, text, jsonb),
  api.call_object_deletion_next(int), api.call_object_deletion_done(text)
  to app_call;
grant execute on function
  api.call_settings_get(uuid, uuid, text), api.call_settings_set(uuid, uuid, text, jsonb, text),
  api.call_recording_access(uuid, uuid, text, uuid, text), api.call_link(uuid, uuid, text, uuid, uuid, text),
  api.call_recording_delete(uuid, uuid, text, uuid, text), api.call_job_requeue(uuid, uuid, text, uuid, text, text),
  api.call_stt_status(uuid, uuid, text), api.call_summary_edit(uuid, uuid, text, uuid, text, text, bigint, text, text),
  api.call_summary_versions(uuid, uuid, text, uuid),
  api.customer_history(uuid, uuid, text, uuid, date, date), api.timeline_by_date(uuid, uuid, text, date, date)
  to app_staff;
-- core.purge_expired_calls()도 예약 작업 전용(앱 역할 부여 없음)

-- core.purge_expired()는 예약 작업(마이그레이션 역할)만 실행한다. 앱 역할에 부여하지 않는다.
-- AI 예산 함수(3단계)는 app_public이 아닌 서버 내부 전용 역할에만 부여한다(REV-004 SEC-04).

-- 9) 배포 전 점검 계정(release_auditor): 읽기 전용 점검 함수 1개만 실행(0006). 테이블·다른 함수 권한은 주지 않는다.
--    이 파일은 모든 마이그레이션 뒤와 DB 복구(pg_dump --no-privileges → pg_restore) 뒤에 다시 적용된다.
--    0006에만 있던 이 2개 권한이 복구 후 사라져 점검이 'permission denied for schema api'로 실패했다(CI 43695544664).
grant usage on schema api to release_auditor;
grant execute on function api.release_probe_product_scope() to release_auditor;

commit;
