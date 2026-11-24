-- 0035 롤백: 스케줄러·활성화 함수 제거. 예약·키워드·CPC 기록 표는 보존(감사 근거), 앱 역할 권한 없음.
begin;
drop function if exists api.ad_sched_finish(uuid, uuid, text, text);
drop function if exists api.ad_sched_gate(uuid, uuid);
drop function if exists api.ad_sched_claim(uuid);
drop function if exists api.ad_enable_cancel(uuid, uuid, text, text, text);
drop function if exists api.ad_enable_schedule(uuid, uuid, text, text, text, timestamptz, text[], text, int, text);
drop function if exists core.ad_enable_check(text, text, text[], int, timestamptz);
drop function if exists api.ad_keyword_revoke(uuid, uuid, text, text, text);
drop function if exists api.ad_keyword_approve(uuid, uuid, text, text, text);
drop function if exists api.ad_cpc_policy_set(uuid, uuid, text, int, text);
commit;
