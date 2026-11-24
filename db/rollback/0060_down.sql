-- 0060 롤백: 재연락·수신 거부 함수 제거(일정 기록 테이블과 수신 이벤트는 보관용으로 남긴다)
drop function if exists api.recontact_schedule(uuid, uuid, text, uuid, date, text);
drop function if exists api.recontact_due(uuid, uuid, text);
drop function if exists api.recontact_close(uuid, uuid, text, bigint, text);
drop function if exists api.recontact_sweep(uuid, uuid, text);
drop function if exists api.marketing_opt_out(text, text, text);
drop function if exists core.recontact_allowed(uuid, text);
