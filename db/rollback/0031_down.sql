-- 0031 롤백: consult_rate_hit를 0024 본문(전체 → IP 순서)으로 되돌린다. 집계 행은 건드리지 않는다.
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
