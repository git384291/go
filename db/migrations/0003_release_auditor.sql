-- 0003_release_auditor.sql
-- 배포 전 권한 점검 전용 계정. 테이블·함수 권한 없음, 시스템 카탈로그만 읽는다.
-- 비밀번호는 마이그레이션에 넣지 않고 운영자가 별도로 설정한다:
--   alter role release_auditor password '<비밀값>';
-- REV-004 SEC-05
begin;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'release_auditor') then
    create role release_auditor login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;
-- 운영 DB의 다른 스키마 접근도 막는다(카탈로그 조회에는 필요 없음)
revoke all on schema core, pii, security, api from release_auditor;
commit;
