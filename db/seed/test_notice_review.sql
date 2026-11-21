-- 가상 고지 검수 승인(테스트 DB 전용): 시험 고지 버전 'privacy-test-v1'을 접수 게이트가 통과시키도록, 문구 작성 이력이 없는 가상 검토자 이름으로 승인 1건을 남긴다. 실제 승인이 아니다.
\set ON_ERROR_STOP 1
insert into core.notice_reviews (version, decision, checks, texts_sha256, reason, reviewer_id)
select 'privacy-test-v1', 'approved',
       '{"source_matched":true,"version_matched":true,"keys_complete":true,"conditions_checked":true,"screen_checked":true}'::jsonb,
       encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex'),
       '시험 시드 승인(가상)', '00000000-0000-4000-8000-0000000000e2'
from core.notice_texts n where n.version = 'privacy-test-v1';
