-- 0014 롤백: 게시 스위치·고지 문구 관리 함수만 삭제한다. 스위치 값(core.feature_flags)·이미 넣은 고지 문구(core.notice_texts, 추가 전용)·감사 로그는 그대로 남는다.
-- 복구: 0014 재적용 후 zz_grants.sql 실행. 롤백 뒤 zz_grants.sql도 이전 버전으로 실행.
begin;
drop function if exists api.notice_text_add(uuid, uuid, text, text, text, text, text);
drop function if exists api.notice_text_list(uuid, uuid, text);
drop function if exists api.policy_publish_set(uuid, uuid, text, boolean, text);
drop function if exists api.policy_publish_get(uuid, uuid, text);
commit;
