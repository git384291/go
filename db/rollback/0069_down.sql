-- 0069 롤백: 설치·정산·환수 api 함수 4개만 제거한다.
-- - 계약·정산 기록 테이블(core.lead_contracts, core.settlements)과 그 보호 트리거(삭제·수정 금지)는 보관용으로 남긴다(기존 데이터 삭제·덮어쓰기 없음).
--   재적용(0069 다시 실행) 시 create table if not exists · create or replace라 남은 기록을 그대로 다시 쓴다.
-- - 0069 밖의 객체는 건드리지 않는다(시험 M69가 지문으로 확인).
-- - 순서: 앱 코드·zz_grants.sql도 함께 되돌린다(PR 되돌리기). zz_grants.sql에 이 4개 함수 권한 줄이 남아 있으면 그 스크립트가 실패한다.
begin;
drop function if exists api.contract_schedule(uuid, uuid, text, uuid, text, date, int, int);
drop function if exists api.contract_status(uuid, uuid, text, uuid, text, date);
drop function if exists api.settlement_record(uuid, uuid, text, uuid, text, int, date);
drop function if exists api.contract_list(uuid, uuid, text, text);
commit;
