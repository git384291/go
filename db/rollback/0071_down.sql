-- 0071 롤백: 가져오기 함수만 제거한다. 불변 고지·이미 가져온 접수·감사 기록은 보존한다.
begin;
drop function if exists api.naver_form_import(uuid, uuid, text, text, text, text, text, text, text, text, boolean, text);
commit;
