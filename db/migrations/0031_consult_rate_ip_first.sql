-- 0031(PR #12의 0030을 PM 11/24 결정으로 번호 변경, 0030_ai_confirm_cap 다음): 상담 공용 횟수 제한 순서 변경(PM 11/24) — IP별 한도 → 전체 한도. **운영 적용은 PM 승인 전 금지.**
--  - 0024는 전체 한도를 먼저 올리고 IP 한도에서 거부해, IP 한도로 막힌 요청도 전체 1회를 소비했다
--    (한 IP·/64가 거부되는 요청을 반복해 전체 1시간 60개 새 세션·1분 120회 메시지를 소진 → 정상 고객 차단).
--  - 이제 IP 한도에서 거부되면 전체 집계는 건드리지 않는다. 전체 한도에서 거부되면 그 IP 1회는 소비된다(자기 버킷만, 같은 창에서 함께 초기화).
--  - 한도 값·서명·권한·반환은 0024와 같다. 잠금 순서는 항상 IP 행 → 전체 행이라 교착 없음.
begin;

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
  insert into core.consult_rate as r (bucket, window_start, hits) values (p_kind || ':' || p_ip_hash, v_win, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1 where r.hits < (case p_kind when 'chat' then 10 else 5 end)
  returning r.hits into v_ip;
  if v_ip is null then
    return false;  -- IP 한도 초과: 전체 집계는 소비하지 않는다
  end if;
  insert into core.consult_rate as r (bucket, window_start, hits) values (p_kind || ':all', v_win, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1 where r.hits < (case p_kind when 'chat' then 120 else 60 end)
  returning r.hits into v_all;
  return v_all is not null;
end
$$;

commit;
