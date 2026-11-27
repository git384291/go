-- 0024 상담 채팅 공용 횟수 제한(PM 11/22 F1). 서버 인스턴스 메모리 제한은 인스턴스마다 따로 세므로, DB 한 곳에서 원자적으로 센다.
-- - api.consult_rate_hit(ip_hash, kind): 전체(서비스 합산) 한도 → IP별 한도 순으로 1 증가를 시도하고, 한도를 넘으면 false(증가 없음).
--   한 행의 증가는 INSERT … ON CONFLICT DO UPDATE … WHERE hits < 한도 한 문장이라 동시 요청에서도 한도를 넘지 않는다(행 잠금).
-- - 한도(계획값): chat 1분 창 — IP 10회·전체 120회 / session 1시간 창 — IP 5개·전체 60개.
--   전체 한도는 비용 폭주 방지의 1차 장치다(실제 AI 비용 상한은 0011·0013의 DB 월 한도, 기본 0원).
-- - IP는 서버 HMAC(원문 IP 아님)만 받는다. 지난 창 정리는 하지 않는다(core 테이블 삭제 권한을 새로 주지 않기 위해 — 운영 정리 작업은 별도, 개인정보 아님).
-- - 전체 한도가 증가된 뒤 IP 한도에서 거부되면 전체 1회가 소비된다(보수적: 더 막는 쪽).
begin;

create table if not exists core.consult_rate (
  bucket       text not null check (bucket ~ '^(chat|session):(all|[0-9a-f]{64})$'),
  window_start timestamptz not null,
  hits         int not null check (hits between 1 and 100000),
  primary key (bucket, window_start)
);
create index if not exists consult_rate_window on core.consult_rate (window_start);
alter table core.consult_rate enable row level security;
alter table core.consult_rate force row level security;

create or replace function api.consult_rate_hit(p_ip_hash text, p_kind text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_win timestamptz;
  v_all int;
  v_ip  int;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' or p_kind is null or p_kind not in ('chat', 'session') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_win := date_trunc(case p_kind when 'chat' then 'minute' else 'hour' end, now());
  insert into core.consult_rate as r (bucket, window_start, hits) values (p_kind || ':all', v_win, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1 where r.hits < (case p_kind when 'chat' then 120 else 60 end)
  returning r.hits into v_all;
  if v_all is null then
    return false;
  end if;
  insert into core.consult_rate as r (bucket, window_start, hits) values (p_kind || ':' || p_ip_hash, v_win, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1 where r.hits < (case p_kind when 'chat' then 10 else 5 end)
  returning r.hits into v_ip;
  return v_ip is not null;
end
$$;

commit;
