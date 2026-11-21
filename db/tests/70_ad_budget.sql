-- 광고 예산 통제(0010): 승인 없으면 차단, 한도·중복·만료·권한. 실제 광고 집행·외부 호출은 없다. 가상 데이터만 사용한다.
\set ON_ERROR_STOP 1

-- p_who: owner | editor | counselor | reviewer
create function test.adcall(p_who text, p_fn text, p_args text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'editor' then '00000000-0000-4000-8000-000000000006'
                       when 'reviewer' then '00000000-0000-4000-8000-000000000005' else '00000000-0000-4000-8000-000000000002' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'editor' then '10000000-0000-4000-8000-000000000008'
                       when 'reviewer' then '10000000-0000-4000-8000-000000000005' else '10000000-0000-4000-8000-000000000002' end;
begin
  return format('select api.%s(%L, %L, %L, %s)', p_fn, a, s, test.staff_token(a, s), p_args);
end $$;
create function test.adapprove(p_who text, p_campaign text, p_daily int, p_total int, p_hours int default 24, p_reason text default '승인 시험') returns text language sql security definer set search_path = test, pg_catalog as $$
  select test.adcall(p_who, 'ad_budget_approve', format('%L, %s, %s, now() + interval ''%s hours'', %L', p_campaign, p_daily, p_total, p_hours, p_reason)) $$;
create function test.adspend(p_who text, p_campaign text, p_amount int, p_key text) returns text language sql security definer set search_path = test, pg_catalog as $$
  select test.adcall(p_who, 'ad_spend_request', format('%L, %s, %L', p_campaign, p_amount, p_key)) $$;
-- 판정 결과를 notice 없이 값으로 돌려받는다(security definer 함수 안에서 app_staff 권한으로 실행)
create function test.addecide(p_who text, p_campaign text, p_amount int, p_key text) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare r jsonb;
begin
  execute test.adspend(p_who, p_campaign, p_amount, p_key) into r;
  return r->>'decision' || ':' || coalesce(r->>'reason', '');
end $$;

-- A1 승인 없음 → 차단(기본 닫힘)
set role app_staff;
select test.expect_eq($$select test.addecide('owner', 'camp-a', 1000, 'req-a-0000000000001')$$, 'BLOCK:NO_APPROVAL', 'A1 승인 없는 캠페인은 지출 차단');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.spend_blocked' and reason = 'NO_APPROVAL'$$, '1', 'A1b 차단도 감사 기록에 남음');
select test.expect_eq($$select count(*)::text from core.ad_spend_ledger$$, '0', 'A1c 차단은 원장에 쓰지 않음');

-- A2 권한: owner만 승인
set role app_staff;
select test.expect_error(test.adapprove('editor', 'camp-a', 10000, 30000), '42501', 'A2 policy_editor 승인 불가');
select test.expect_error(test.adapprove('counselor', 'camp-a', 10000, 30000), '42501', 'A2b 상담원 승인 불가');
select test.expect_error(test.adapprove('reviewer', 'camp-a', 10000, 30000), '42501', 'A2c 검토자 승인 불가');
-- A3 한도 상한·기간·사유 검증
select test.expect_error(test.adapprove('owner', 'camp-a', 10001, 30000), '22023', 'A3 일 한도 상한 초과 거부');
select test.expect_error(test.adapprove('owner', 'camp-a', 5000, 30001), '22023', 'A3b 총 한도 상한 초과 거부');
select test.expect_error(test.adapprove('owner', 'camp-a', 5000, 4000), '22023', 'A3c 총 한도가 일 한도보다 작으면 거부');
select test.expect_error(test.adapprove('owner', 'camp-a', 5000, 20000, p_hours => 73), '22023', 'A3d 3일 넘는 기간 거부');
select test.expect_error(test.adapprove('owner', 'camp-a', 5000, 20000, p_hours => -1), '22023', 'A3e 이미 지난 만료 시각 거부');
select test.expect_error(test.adapprove('owner', 'Camp A!', 5000, 20000), '22023', 'A3f 캠페인 키 형식 거부');
select test.expect_error(test.adapprove('owner', 'camp-a', 5000, 20000, p_reason => ' '), '22023', 'A3g 사유 필수');
select test.expect_ok(test.adapprove('owner', 'camp-a', 10000, 30000), 'A4 대표 승인');
reset role;
select test.expect_eq($$select count(*)::text from core.ad_budget_approvals where campaign_key = 'camp-a' and state = 'active'$$, '1', 'A4b 활성 승인 1건');

-- A5~A7 지출 판정
set role app_staff;
select test.expect_eq($$select test.addecide('owner', 'camp-a', 4000, 'req-a-0000000000002')$$, 'ALLOW:', 'A5 승인 범위 안 지출 허용');
select test.expect_eq($$select test.addecide('owner', 'camp-a', 4000, 'req-a-0000000000002')$$, 'BLOCK:DUPLICATE_REQUEST', 'A6 같은 요청 키 재전송은 차단(이중 과금 방지)');
select test.expect_eq($$select test.addecide('owner', 'camp-a', 6000, 'req-a-0000000000003')$$, 'ALLOW:', 'A6b 일 한도까지 허용');
select test.expect_eq($$select test.addecide('owner', 'camp-a', 1, 'req-a-0000000000004')$$, 'BLOCK:DAILY_CAP_EXCEEDED', 'A7 일 한도 초과 차단');
select test.expect_error(test.adspend('editor', 'camp-a', 1000, 'req-a-0000000000005'), '42501', 'A8 policy_editor 지출 판정 불가');
select test.expect_error(test.adspend('counselor', 'camp-a', 1000, 'req-a-0000000000005'), '42501', 'A8b 상담원 지출 판정 불가');
select test.expect_error(test.adspend('reviewer', 'camp-a', 1000, 'req-a-0000000000005'), '42501', 'A8c 검토자 지출 판정 불가');
select test.expect_error(test.adspend('owner', 'camp-a', 0, 'req-a-0000000000006'), '22023', 'A9 금액 0 거부');
select test.expect_error(test.adspend('owner', 'camp-a', 10001, 'req-a-0000000000006'), '22023', 'A9b 금액 상한 초과 거부');
select test.expect_error(test.adspend('owner', 'camp-a', 100, 'short'), '22023', 'A9c 요청 키 형식 거부');
select test.expect_error(test.adspend('owner', 'Bad Key', 100, 'req-a-0000000000006'), '22023', 'A9d 캠페인 키 형식 거부');
reset role;
select test.expect_eq($$select coalesce(sum(amount_krw), 0)::text from core.ad_spend_ledger where campaign_key = 'camp-a'$$, '10000', 'A10 원장 합계 = 허용된 지출만');
select test.expect_eq($$select count(*)::text from core.audit_logs where action = 'ad.spend_allow'$$, '2', 'A10b 허용 감사 기록 2건');

-- A11 철회 → 다시 차단
set role app_staff;
select test.expect_error(test.adcall('editor', 'ad_budget_revoke', $$'camp-a', '철회 시험'$$), '42501', 'A11 policy_editor 철회 불가');
select test.expect_ok(test.adcall('owner', 'ad_budget_revoke', $$'camp-a', '철회 시험'$$), 'A11b 대표 철회');
select test.expect_eq($$select test.addecide('owner', 'camp-a', 1, 'req-a-0000000000007')$$, 'BLOCK:NO_APPROVAL', 'A11c 철회 뒤 지출 차단');
select test.expect_error(test.adcall('owner', 'ad_budget_revoke', $$'camp-a', '철회 시험'$$), '22023', 'A11d 활성 승인 없으면 철회 거부');
reset role;

-- A12 같은 캠페인 재승인은 기존 승인을 교체(활성은 항상 1건)
set role app_staff;
select test.expect_ok(test.adapprove('owner', 'camp-b', 5000, 12000), 'A12 camp-b 승인');
select test.expect_ok(test.adapprove('owner', 'camp-b', 5000, 12000, p_reason => '재승인'), 'A12b camp-b 재승인(교체)');
reset role;
select test.expect_eq($$select count(*) filter (where state = 'active')::text || '/' || count(*)::text from core.ad_budget_approvals where campaign_key = 'camp-b'$$, '1/2', 'A12c 활성 1건·이전 승인은 철회로 보존');

-- A13 만료된 승인 → 차단 (관리자 연결로 기간을 과거로 만든 승인 삽입)
insert into core.ad_budget_approvals (campaign_key, daily_cap_krw, total_cap_krw, valid_from, valid_until, approved_by, reason)
values ('camp-exp', 5000, 5000, now() - interval '2 hours', now() - interval '1 hour', '00000000-0000-4000-8000-000000000001', '만료 시험');
set role app_staff;
select test.expect_eq($$select test.addecide('owner', 'camp-exp', 100, 'req-e-0000000000001')$$, 'BLOCK:APPROVAL_EXPIRED', 'A13 만료된 승인은 차단');
reset role;

-- A14 총 한도: 어제 9,000원 지출(원장에 직접 기록) + 오늘 4,000원 → 일 한도는 통과하지만 총 한도 초과
select set_config('t.bid', (select id::text from core.ad_budget_approvals where campaign_key = 'camp-b' and state = 'active'), false);
insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
values ('camp-b', current_setting('t.bid')::uuid, (now() at time zone 'Asia/Seoul')::date - 1, 9000, 'req-b-0000000000001', '00000000-0000-4000-8000-000000000001');
set role app_staff;
select test.expect_eq($$select test.addecide('owner', 'camp-b', 4000, 'req-b-0000000000002')$$, 'BLOCK:TOTAL_CAP_EXCEEDED', 'A14 총 한도 초과 차단');
select test.expect_eq($$select test.addecide('owner', 'camp-b', 3000, 'req-b-0000000000003')$$, 'ALLOW:', 'A14b 총 한도 안이면 허용');
reset role;

-- A15 원장·승인 내용은 수정·삭제 불가
select test.expect_error($$update core.ad_spend_ledger set amount_krw = 1$$, '42501', 'A15 원장 수정 불가');
select test.expect_error($$delete from core.ad_spend_ledger$$, '42501', 'A15b 원장 삭제 불가');
select test.expect_error($$update core.ad_budget_approvals set daily_cap_krw = 1 where campaign_key = 'camp-b' and state = 'active'$$, '42501', 'A15c 승인 한도 수정 불가');
select test.expect_error($$delete from core.ad_budget_approvals$$, '42501', 'A15d 승인 삭제 불가');
select test.expect_error($$update core.ad_budget_approvals set state = 'active' where campaign_key = 'camp-a'$$, '42501', 'A15e 철회된 승인을 되살릴 수 없음');

-- A16 RLS·직접 접근
select test.expect_eq($$select count(*)::text from pg_class where oid in ('core.ad_budget_approvals'::regclass, 'core.ad_spend_ledger'::regclass) and relrowsecurity and relforcerowsecurity$$, '2', 'A16 두 테이블 RLS enable+force');
set role app_staff;
select test.expect_error($$select * from core.ad_spend_ledger$$, '42501', 'A16b 직원 역할은 원장을 직접 읽을 수 없음');
set role app_public;
select test.expect_error($$select api.ad_budget_overview('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'x', 10)$$, '42501', 'A16c 공개 역할은 예산 함수 실행 불가');
reset role;

-- A17 조회: owner·reviewer 가능, 상담원 불가, 페이지 검증
create function test.adlist(p_who text, p_limit int) returns text language plpgsql security definer set search_path = test, pg_catalog as $$
declare
  a uuid := case p_who when 'owner' then '00000000-0000-4000-8000-000000000001' when 'reviewer' then '00000000-0000-4000-8000-000000000005' else '00000000-0000-4000-8000-000000000002' end;
  s uuid := case p_who when 'owner' then '10000000-0000-4000-8000-000000000001' when 'reviewer' then '10000000-0000-4000-8000-000000000005' else '10000000-0000-4000-8000-000000000002' end;
begin
  return format('select count(*) from api.ad_budget_overview(%L, %L, %L, %s)', a, s, test.staff_token(a, s), p_limit);
end $$;
set role app_staff;
select test.expect_ok(test.adlist('owner', 10), 'A17 대표 조회');
select test.expect_ok(test.adlist('reviewer', 10), 'A17b 검토자 조회');
select test.expect_error(test.adlist('counselor', 10), '42501', 'A17c 상담원 조회 불가');
select test.expect_error(test.adlist('owner', 0), '22023', 'A17d 페이지 크기 0 거부');
reset role;
select test.expect_eq($$select count(*)::text from core.audit_logs where action in ('ad.budget_approve', 'ad.budget_revoke')$$, '4', 'A18 승인 3건·철회 1건 감사 기록');
