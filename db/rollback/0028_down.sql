-- 0028 롤백: 새 함수 제거 후 0012 서명 복원은 0011·0012 마이그레이션 재실행으로 한다(추가 전용 원장·정산 기록은 남긴다).
drop function if exists api.ai_budget_hold(int, text, text);
drop function if exists api.ai_budget_uncertain(bigint);
drop function if exists api.ai_budget_adjust(uuid, uuid, text, bigint, int, text);
drop function if exists api.ai_budget_pause_set(uuid, uuid, text, boolean, text);
drop function if exists api.ai_budget_limits_set(uuid, uuid, text, int, int, int, int, text);
