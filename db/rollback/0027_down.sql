-- 0027 롤백: gclid 귀속 함수 제거, 파기 함수 2개를 0002 본문으로 복원(0002의 두 함수 정의를 다시 실행), 클릭 식별값 표 삭제(저장된 gclid도 지워진다).
-- 롤백 뒤 zz_grants.sql도 이전 버전으로 실행.
begin;
drop function if exists api.lead_gclid_attach(text, text, text, text);
drop table if exists pii.lead_clicks;
drop function if exists core.lead_clicks_guard();
commit;
-- 이어서: db/migrations/0002_leads.sql의 core.purge_customer_internal·core.purge_expired 정의를 다시 실행한다.
