-- 설계 초안 0007 단일 세션 시험. 로컬 폐기용 DB에서만(scripts/design/login-attempts-local.sh).
-- 값은 모두 가상 hex fixture(개인정보·실제 키 아님). 출력은 PASS/FAIL 라벨.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

-- 호출 도우미: 토큰은 시험 소유자(초안 실행 역할)가 가상 키로 만들고, 호출은 app_public으로 전환해 한다.
create function test.d7_reserve(p_step text, p_s text, p_ip text, p_n text, p_ttl int default 30,
                                p_purpose text default 'login', p_fields text[] default null, p_role text default 'app_public')
returns uuid language plpgsql as $$
declare t text; r uuid;
begin
  t := test.token(p_purpose, coalesce(p_fields, array['reserve-request', p_step, p_s, p_ip, p_n]), p_ttl);
  execute format('set local role %I', p_role);
  r := api.login_attempt_reserve(p_step, p_s, p_ip, p_n, t);
  reset role;
  return r;
end $$;

create function test.d7_settle(p_id uuid, p_result text, p_ttl int default 30, p_signed_result text default null,
                               p_purpose text default 'login', p_fields text[] default null)
returns text language plpgsql as $$
declare t text; r text; a security.login_attempts;
begin
  select * into a from security.login_attempts where id = p_id;
  t := test.token(p_purpose, coalesce(p_fields, array['settle', p_id::text, a.step, a.subject_hmac, a.ip_hash, coalesce(p_signed_result, p_result)]), p_ttl);
  set local role app_public;
  r := api.login_attempt_settle(p_id, p_result, t);
  reset role;
  return r;
end $$;

create function test.d7_hex(p text, n int) returns text language sql immutable as $$ select repeat(p, n) $$;
create function test.d7_nonce(i int) returns text language sql immutable as $$ select lpad(to_hex(i), 32, '0') $$;
create function test.d7_count(p_step text, p_s text, p_ip text, p_scope text) returns int language sql as $$
  select security.login_limit_count(p_step, p_s, p_ip, p_scope) $$;

-- ---------------------------------------------------------------- 정상·서명 결합
select test.expect_ok($$ select test.d7_reserve('password', repeat('a',64), repeat('1',64), test.d7_nonce(1)) $$, 'L1 정상 예약(서명·목적 login·nonce·60초 이내)');
select test.expect_eq($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(1)), 'failure') $$, 'settled', 'L2 정상 정산(서명된 결과)');
select test.expect_eq($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(1)), 'failure') $$, 'already', 'L3 같은 결과 재전송 무해(멱등)');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(1)), 'success') $$, '42501', 'L4 이미 확정된 예약에 반대 결과 → RESULT_CONFLICT');
select test.expect_error($$ select test.d7_reserve('password', repeat('a',64), repeat('1',64), test.d7_nonce(1)) $$, '42501', 'L5 같은 nonce 재사용(새 서명이어도) → NONCE_REUSED');

-- ---------------------------------------------------------------- 서명·목적·만료·변조 거부
select test.expect_error($$ select test.d7_reserve('password', repeat('a',64), repeat('1',64), test.d7_nonce(2), p_fields => array['reserve-request','password',repeat('a',64),repeat('1',64),test.d7_nonce(99)]) $$, '42501', 'L6 다른 nonce로 서명된 토큰 → 거부');
select test.expect_error($$ select test.d7_reserve('password', repeat('a',64), repeat('1',64), test.d7_nonce(3), p_fields => array['reserve-request','password',repeat('b',64),repeat('1',64),test.d7_nonce(3)]) $$, '42501', 'L7 다른 대상으로 서명된 토큰 → 거부');
select test.expect_error($$ select test.d7_reserve('totp', repeat('a',64), repeat('1',64), test.d7_nonce(4), p_fields => array['reserve-request','password',repeat('a',64),repeat('1',64),test.d7_nonce(4)]) $$, '42501', 'L8 다른 단계로 서명된 토큰 → 거부');
select test.expect_error($$ select test.d7_reserve('password', repeat('a',64), repeat('1',64), test.d7_nonce(5), p_purpose => 'staff') $$, '42501', 'L9 목적 재사용(staff 키로 같은 필드 서명) → 거부');
select test.expect_error($$ select test.d7_reserve('password', repeat('a',64), repeat('1',64), test.d7_nonce(6), p_ttl => -1) $$, '42501', 'L10 만료된 토큰 → 거부');
select test.expect_error($$ select test.d7_reserve('password', repeat('a',64), repeat('1',64), test.d7_nonce(7), p_ttl => 120) $$, '42501', 'L11 유효시간 60초 초과 토큰 → 거부(verify_token 300초보다 좁힘)');
select test.expect_error($$ select test.d7_reserve('password', 'A'||repeat('a',63), repeat('1',64), test.d7_nonce(8)) $$, '42501', 'L12 형식 오류 대상(대문자) → 거부');
select test.expect_error($$ select test.d7_reserve('admin', repeat('a',64), repeat('1',64), test.d7_nonce(9)) $$, '42501', 'L13 알 수 없는 단계 → 거부');

select test.expect_ok($$ select test.d7_reserve('password', repeat('c',64), repeat('1',64), test.d7_nonce(10)) $$, 'L14 준비: 정산 변조 시험용 예약');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(10)), 'success', p_signed_result => 'failure') $$, '42501', 'L15 결과 변조(failure 서명으로 success 제출) → 거부');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(10)), 'success', p_purpose => 'staff') $$, '42501', 'L16 정산 목적 재사용(staff 키) → 거부');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(10)), 'success',
  p_fields => array['reserve-request','password',repeat('c',64),repeat('1',64),test.d7_nonce(10)]) $$, '42501', 'L17 예약 토큰을 정산에 재사용 → 거부');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(1)), 'failure',
  p_fields => array['settle', (select id::text from security.login_attempts where request_nonce = test.d7_nonce(10)), 'password', repeat('a',64), repeat('1',64), 'failure']) $$, '42501', 'L18 다른 예약 ID로 서명된 정산 토큰 → 거부');
select test.expect_error($$ select test.d7_settle(gen_random_uuid(), 'failure') $$, '42501', 'L19 없는 예약 → 거부');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(10)), 'expired') $$, '42501', 'L20 서버가 expired를 직접 확정할 수 없음');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(10)), 'success', p_ttl => -1) $$, '42501', 'L21 만료된 정산 토큰 → 거부');

-- ---------------------------------------------------------------- 권한·RLS·설정
select test.expect_error($$ select test.d7_reserve('password', repeat('d',64), repeat('1',64), test.d7_nonce(11), p_role => 'app_staff') $$, '42501', 'L22 app_staff 실행 권한 없음');
select test.expect_error($$ select test.d7_reserve('password', repeat('d',64), repeat('1',64), test.d7_nonce(12), p_role => 'app_server') $$, '42501', 'L23 app_server(역할 전환 전) 실행 권한 없음');
do $$ begin
  set local role app_public;
  perform test.expect_error('select count(*) from security.login_attempts', '42501', 'L24 app_public 테이블 직접 조회 불가');
  perform test.expect_error('select security.login_limit_count(''password'', repeat(''a'',64), repeat(''1'',64), ''ip'')', '42501', 'L25 app_public 보조 함수 직접 실행 불가');
end $$;
select test.expect_eq($$ select relrowsecurity::text || '/' || relforcerowsecurity::text from pg_class where oid = 'security.login_attempts'::regclass $$, 'true/true', 'L26 RLS enable + FORCE');
select test.expect_eq($$ select string_agg(p.proname || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ','), ' ' order by p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname like 'login_attempt_%' $$,
  'login_attempt_reserve:true:search_path="",lock_timeout=2s login_attempt_settle:true:search_path="",lock_timeout=2s', 'L27 api 함수 SECURITY DEFINER·search_path 고정·lock_timeout');
select test.expect_eq($$ select string_agg(p.proname || ':' || p.prosecdef::text, ' ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'security' and p.proname like 'login_%' $$, 'login_expire_stale:false login_limit_count:false login_lock:false login_token_short:false', 'L28 보조 함수는 invoker(정의자 권한 확대 없음)');
select test.expect_eq($$ select (select pg_get_userbyid(proowner) from pg_proc where oid = 'api.login_attempt_reserve(text,text,text,text,text)'::regprocedure) $$, 'fideon_api', 'L29 api 함수 소유자 fideon_api');

-- ---------------------------------------------------------------- 한도(대기 포함)·만료·지연 성공
-- (대상 e, IP 2): 실패 4 + 대기 1 = 5 → 6번째 거부(대기 중인 예약도 센다)
do $$ begin
  for i in 1..4 loop perform test.d7_settle(test.d7_reserve('password', repeat('e',64), repeat('2',64), test.d7_nonce(100 + i)), 'failure'); end loop;
  perform test.d7_reserve('password', repeat('e',64), repeat('2',64), test.d7_nonce(105));   -- 대기(결과 없음)
end $$;
select test.expect_error($$ select test.d7_reserve('password', repeat('e',64), repeat('2',64), test.d7_nonce(106)) $$, 'P0429', 'L30 실패 4 + 대기 1 → 6번째 LOGIN_RATE_LIMITED');
select test.expect_ok($$ select test.d7_reserve('password', repeat('e',64), repeat('3',64), test.d7_nonce(107)) $$, 'L31 같은 대상·다른 IP는 영향 없음(대상 전체 잠금 없음 → 잠금 DoS 완화)');

-- 결과 없이 60초 지난 대기는 expired로 확정되고 실패로 센다. 시각은 행을 역산해 결정적으로 만든다.
insert into security.login_attempts (step, subject_hmac, ip_hash, request_nonce, created_at)
select 'password', repeat('f',64), repeat('4',64), test.d7_nonce(200 + i), now() - interval '2 minutes' from generate_series(1, 5) i;
select test.expect_error($$ select test.d7_reserve('password', repeat('f',64), repeat('4',64), test.d7_nonce(206)) $$, 'P0429', 'L32 60초 지난 대기 5건 → 실패로 세어 거부');
do $$ begin perform test.d7_reserve('password', repeat('f',64), repeat('5',64), test.d7_nonce(207)); end $$;   -- 같은 대상 다른 IP 예약 시 정리 실행
select test.expect_eq($$ select count(*)::text from security.login_attempts where subject_hmac = repeat('f',64) and ip_hash = repeat('4',64) and result = 'expired' $$, '5', 'L33 오래된 대기 → expired로 확정');
select test.expect_error($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(201)), 'success') $$, '42501', 'L34 만료(expired) 예약은 success로 바꿀 수 없음');

-- 지연 성공: 성공 예약 R(40초 전 생성)보다 먼저 생긴 실패 2건은 지우고, 뒤에 생긴 실패 3건은 남긴다
insert into security.login_attempts (step, subject_hmac, ip_hash, request_nonce, created_at, settled_at, result)
select 'password', repeat('9',64), repeat('6',64), test.d7_nonce(300 + i), now() - interval '50 seconds', now() - interval '45 seconds', 'failure' from generate_series(1, 2) i;
insert into security.login_attempts (step, subject_hmac, ip_hash, request_nonce, created_at)
values ('password', repeat('9',64), repeat('6',64), test.d7_nonce(310), now() - interval '40 seconds');
insert into security.login_attempts (step, subject_hmac, ip_hash, request_nonce, created_at, settled_at, result)
select 'password', repeat('9',64), repeat('6',64), test.d7_nonce(320 + i), now() - interval '30 seconds', now() - interval '20 seconds', 'failure' from generate_series(1, 3) i;
select test.expect_eq($$ select test.d7_count('password', repeat('9',64), repeat('6',64), 'subject_ip')::text $$, '6', 'L35 준비: 실패 5 + 대기 1');
select test.expect_eq($$ select test.d7_settle((select id from security.login_attempts where request_nonce = test.d7_nonce(310)), 'success') $$, 'settled', 'L36 늦게 도착한 성공 확정(60초 이내)');
select test.expect_eq($$ select test.d7_count('password', repeat('9',64), repeat('6',64), 'subject_ip')::text $$, '3', 'L37 지연 성공은 이전 실패 2건만 지우고 이후 실패 3건은 남김');
select test.expect_eq($$ select test.d7_count('password', repeat('9',64), repeat('6',64), 'ip')::text $$, '5', 'L38 IP 버킷은 성공으로 초기화하지 않음');

-- IP 전체 한도 20(서로 다른 대상), TOTP는 대상 기준(IP 무관)
do $$ begin
  for i in 1..20 loop perform test.d7_settle(test.d7_reserve('password', lpad(to_hex(i), 64, '7'), repeat('8',64), test.d7_nonce(400 + i)), 'failure'); end loop;
end $$;
select test.expect_error($$ select test.d7_reserve('password', repeat('0',64), repeat('8',64), test.d7_nonce(421)) $$, 'P0429', 'L39 같은 IP 서로 다른 대상 실패 20 → 21번째 거부');
do $$ begin
  for i in 1..5 loop perform test.d7_settle(test.d7_reserve('totp', repeat('b',64), lpad(to_hex(i), 64, 'c'), test.d7_nonce(500 + i)), 'failure'); end loop;
end $$;
select test.expect_error($$ select test.d7_reserve('totp', repeat('b',64), repeat('d',64), test.d7_nonce(506)) $$, 'P0429', 'L40 TOTP 같은 사용자 실패 5(IP 달라도) → 거부');
select test.expect_ok($$ select test.d7_reserve('password', repeat('b',64), repeat('d',64), test.d7_nonce(507)) $$, 'L41 TOTP 실패는 비밀번호 단계 계수와 분리');
