-- 0016: 접수 직전 고지 승인 게이트 (PM 11/21). 접수 개방 없음 — 코드 상수 미확정이면 서버가 DB까지 오기 전에 이미 거부한다.
--  api.notice_intake_gate(버전, 키별 문구 해시): 접수 API(서버)가 "서버 코드 상수의 문구 해시"를 보내면, DB가 아래를 모두 확인하고 하나라도 어긋나면 접수를 막는다(모두 errcode 55000).
--   NOTICE_INVALID          입력 형식 오류
--   NOTICE_VERSION_MISMATCH 접수 문서 버전이 core.settings.privacy_policy_version과 다름
--   NOTICE_NOT_FOUND        그 버전의 DB 고지 문구가 없음
--   NOTICE_KEYS_MISMATCH    DB 항목 키 집합과 서버 상수의 키 집합이 다름
--   NOTICE_HASH_MISMATCH    DB 문구 해시와 서버 상수 문구 해시가 다름(코드↔DB 불일치)
--   NOTICE_NOT_APPROVED     최신 검수 기록이 승인이 아님(기록 없음 또는 이후 반려 = 승인 취소)
--   NOTICE_CHANGED          승인 이후 문구가 추가되어 승인 시점 문구 묶음과 다름
--   NOTICE_SELF_APPROVED    승인자가 그 버전 문구의 작성자(직접 기록 삽입 등 우회 방어)
begin;

create or replace function api.notice_intake_gate(p_version text, p_hashes jsonb)
returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_set    text;
  v_review core.notice_reviews;
begin
  if p_version is null or p_version = '' or p_hashes is null or jsonb_typeof(p_hashes) <> 'object' or p_hashes = '{}'::jsonb then
    raise exception 'NOTICE_INVALID' using errcode = '55000';
  end if;
  if p_version is distinct from (select s.value #>> '{}' from core.settings s where s.key = 'privacy_policy_version') then
    raise exception 'NOTICE_VERSION_MISMATCH' using errcode = '55000';
  end if;
  select encode(sha256(convert_to(string_agg(n.notice_key || ':' || n.body_sha256, E'\n' order by n.notice_key), 'UTF8')), 'hex') into v_set
    from core.notice_texts n where n.version = p_version;
  if v_set is null then
    raise exception 'NOTICE_NOT_FOUND' using errcode = '55000';
  end if;
  if (select array_agg(n.notice_key order by n.notice_key) from core.notice_texts n where n.version = p_version)
     is distinct from (select array_agg(k order by k) from jsonb_object_keys(p_hashes) k) then
    raise exception 'NOTICE_KEYS_MISMATCH' using errcode = '55000';
  end if;
  if exists (select 1 from core.notice_texts n where n.version = p_version and (p_hashes ->> n.notice_key) is distinct from n.body_sha256) then
    raise exception 'NOTICE_HASH_MISMATCH' using errcode = '55000';
  end if;
  select * into v_review from core.notice_reviews r where r.version = p_version order by r.created_at desc, r.id desc limit 1;
  if v_review.id is null or v_review.decision <> 'approved' then
    raise exception 'NOTICE_NOT_APPROVED' using errcode = '55000';
  end if;
  if v_review.texts_sha256 is distinct from v_set then
    raise exception 'NOTICE_CHANGED' using errcode = '55000';
  end if;
  if exists (select 1 from core.audit_logs a where a.action = 'notice.text_add' and a.detail ->> 'version' = p_version and a.actor_id = v_review.reviewer_id) then
    raise exception 'NOTICE_SELF_APPROVED' using errcode = '55000';
  end if;
end
$$;

commit;
