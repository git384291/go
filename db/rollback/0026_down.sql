-- 0026 롤백: 키별 접수 규칙 게이트를 0025 게이트(잠금·충돌 검사만)로 되돌린다(데이터 변경 없음).
begin;
drop function if exists api.policy_intake_gate(text, text, text);
create or replace function api.policy_intake_gate()
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(7302251124);
  if exists (
    select 1 from core.policy_versions v
     where v.state = 'approved' and v.valid_from <= now() and v.valid_until > now()
     group by v.policy_key having count(*) > 1
  ) then
    raise exception 'POLICY_UNVERIFIED' using errcode = '55000';
  end if;
end
$$;
revoke all on function api.policy_intake_gate() from public;
do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'fideon_api') then execute 'alter function api.policy_intake_gate() owner to fideon_api'; end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'app_public') then execute 'grant execute on function api.policy_intake_gate() to app_public'; end if;
end $$;
commit;
