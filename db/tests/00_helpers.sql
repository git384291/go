-- 테스트 전용 헬퍼. 로컬·CI 테스트 DB에만 만든다(운영 마이그레이션에 포함하지 않음).
\set ON_ERROR_STOP 1
drop schema if exists test cascade;
create schema test;

-- 테스트 키로 서버 서명을 만든다(서버 TypeScript의 signToken과 같은 규칙)
-- 고정 만료값(초)으로 서명한다(PM 6918034030). 같은 기준 시각에서 만료값을 정해 두면 실행 중 초가 바뀌어도
-- 서로 다른 서명이 같은 값으로 겹치지 않는다(test.token은 호출 시점 now()+ttl이라 초 경계에서 겹칠 수 있음).
create function test.token_at(p_purpose text, p_fields text[], p_exp bigint) returns text
language plpgsql as $$
declare
  v_secret bytea;
  v_msg text;
begin
  select secret into v_secret from security.server_keys where purpose = p_purpose and key_id = 1;
  select 'fideon|' || p_purpose || '|1|' || p_exp || coalesce(
           string_agg('|' || encode(extensions.digest(convert_to(coalesce(f, ''), 'UTF8'), 'sha256'), 'hex'), '' order by ord), '')
    into v_msg
  from unnest(p_fields) with ordinality as t(f, ord);
  return '1.' || p_exp || '.' || encode(extensions.hmac(convert_to(v_msg, 'UTF8'), v_secret, 'sha256'), 'hex');
end
$$;

create function test.token(p_purpose text, p_fields text[], p_ttl int default 120) returns text
language plpgsql as $$
declare
  v_exp bigint := floor(extract(epoch from now()))::bigint + p_ttl;
  v_secret bytea;
  v_msg text;
begin
  select secret into v_secret from security.server_keys where purpose = p_purpose and key_id = 1;
  select 'fideon|' || p_purpose || '|1|' || v_exp || coalesce(
           string_agg('|' || encode(extensions.digest(convert_to(coalesce(f, ''), 'UTF8'), 'sha256'), 'hex'), '' order by ord), '')
    into v_msg
  from unnest(p_fields) with ordinality as t(f, ord);
  return '1.' || v_exp || '.' || encode(extensions.hmac(convert_to(v_msg, 'UTF8'), v_secret, 'sha256'), 'hex');
end
$$;

create function test.staff_token(p_actor uuid, p_session uuid) returns text
language sql as $$ select test.token('staff', array[p_actor::text, p_session::text]) $$;

-- 현재 역할(set role로 바꾼 역할) 권한으로 SQL을 실행해 기대 결과를 확인한다
create function test.expect_error(p_sql text, p_sqlstate text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_sqlstate then
      raise notice 'PASS | % | % (%)', p_label, sqlstate, sqlerrm;
      return;
    end if;
    raise exception 'FAIL | % | expected %, got % (%)', p_label, p_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL | % | expected error %, but succeeded', p_label, p_sqlstate;
end
$$;

create function test.expect_ok(p_sql text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise notice 'PASS | % | ok', p_label;
exception when others then
  raise exception 'FAIL | % | expected success, got % (%)', p_label, sqlstate, sqlerrm;
end
$$;

create function test.expect_eq(p_sql text, p_expected text, p_label text) returns void
language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  if v is distinct from p_expected then
    raise exception 'FAIL | % | expected %, got %', p_label, p_expected, v;
  end if;
  raise notice 'PASS | % | %', p_label, v;
end
$$;

grant usage on schema test to app_public, app_staff;
grant execute on all functions in schema test to app_public, app_staff;
revoke execute on function test.token(text, text[], int), test.token_at(text, text[], bigint), test.staff_token(uuid, uuid) from public, app_public, app_staff;
