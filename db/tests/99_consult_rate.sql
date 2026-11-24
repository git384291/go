-- 상담 채팅 공용 횟수 제한(0024, PM 11/22 F1): IP별·전체 한도, 형식 검사, 공개 역할은 함수만, 테이블 직접 접근 불가. 가상 데이터만.
\set ON_ERROR_STOP 1
reset role;
delete from core.consult_rate;
set role app_public;
select test.expect_eq($$select string_agg(api.consult_rate_hit(repeat('a1', 32), 'chat')::text, ',') from generate_series(1, 12)$$, 'true,true,true,true,true,true,true,true,true,true,false,false', 'CR1 같은 IP chat: 1분 10회까지 허용, 11번째부터 거부');
select test.expect_eq($$select api.consult_rate_hit(repeat('b2', 32), 'chat')::text$$, 'true', 'CR2 다른 IP는 따로 센다');
select test.expect_eq($$select string_agg(api.consult_rate_hit(repeat('a1', 32), 'session')::text, ',') from generate_series(1, 6)$$, 'true,true,true,true,true,false', 'CR3 새 세션: IP당 1시간 5개');
select test.expect_error($$select api.consult_rate_hit('not-a-hash', 'chat')$$, '22023', 'CR4 IP 해시 형식 아님 거부(원문 IP 불가)');
select test.expect_error($$select api.consult_rate_hit(repeat('a1', 32), 'other')$$, '22023', 'CR5 종류 밖 거부');
select test.expect_error($$select * from core.consult_rate$$, '42501', 'CR6 공개 역할은 집계 테이블을 읽을 수 없음');
select test.expect_error($$delete from core.consult_rate$$, '42501', 'CR7 공개 역할은 집계를 지울 수 없음(제한 초기화 우회 불가)');
reset role;
-- 전체 한도(비용 폭주 방지): 서로 다른 IP 130개가 1분에 1회씩 → 전체 120회까지만 허용
delete from core.consult_rate;
set role app_public;
select test.expect_eq($$select count(*) filter (where ok)::text || '/' || count(*) filter (where not ok)::text from (select api.consult_rate_hit(lpad(to_hex(g), 64, '0'), 'chat') as ok from generate_series(1, 130) g) x$$, '120/10', 'CR8 IP를 바꿔도 전체 1분 120회 상한');
reset role;
select test.expect_eq($$select hits::text from core.consult_rate where bucket = 'chat:all'$$, '120', 'CR9 전체 집계는 상한을 넘지 않음');
delete from core.consult_rate;
-- 0030: IP 한도로 거부된 요청은 전체 집계를 소비하지 않는다(한 IP가 전체 한도를 소진해 정상 고객을 막지 못함)
set role app_public;
select test.expect_eq($$select count(*) filter (where ok)::text || '/' || count(*) filter (where not ok)::text from (select api.consult_rate_hit(repeat('c3', 32), 'session') as ok from generate_series(1, 100)) x$$, '5/95', 'CR10 같은 IP 새 세션 100회 → 5회만 허용');
reset role;
select test.expect_eq($$select hits::text from core.consult_rate where bucket = 'session:all'$$, '5', 'CR11 IP 한도로 거부된 95회는 전체 집계 미소비(0030)');
set role app_public;
select test.expect_eq($$select count(*) filter (where ok)::text from (select api.consult_rate_hit(lpad(to_hex(g), 64, '0'), 'session') as ok from generate_series(1, 55) g) x$$, '55', 'CR12 그 뒤 다른 정상 IP 55명 모두 새 세션 허용(전체 60 = 5 + 55)');
select test.expect_eq($$select api.consult_rate_hit(lpad(to_hex(56), 64, '0'), 'session')::text$$, 'false', 'CR13 전체 60 도달 후 새 IP 거부(전체 상한 유지)');
reset role;
select test.expect_eq($$select hits::text from core.consult_rate where bucket = 'session:' || lpad(to_hex(56), 64, '0')$$, '1', 'CR14 전체 한도 거부 시 그 IP 1회만 소비(자기 버킷, 같은 창에서 초기화)');
delete from core.consult_rate;
