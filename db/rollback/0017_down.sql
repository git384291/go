-- 0017 롤백: 함수 4개만 삭제한다. 이미 저장된 암호화 신청서(pii.lead_applications)·전달 이력(core.dealer_handoffs, 추가 전용)·감사 로그는 그대로 남는다.
-- 롤백하면 접수 코드가 api.application_save를 부르지 못하므로 접수 코드도 이전 커밋으로 함께 되돌려야 한다(docs/DEPLOY-CHECKLIST.md L절).
-- 복구: 0017 재적용 후 zz_grants.sql 실행.
begin;
drop function if exists api.handoff_list(uuid, uuid, text, uuid);
drop function if exists api.handoff_record(uuid, uuid, text, uuid, text, text);
drop function if exists api.dealer_packet_get(uuid, uuid, text, uuid, text);
drop function if exists api.application_save(text, text, text, text);
commit;
