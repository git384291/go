-- 0024 롤백: 상담 공용 횟수 제한 함수 제거(창 집계 테이블은 남긴다, 개인정보 없음)
drop function if exists api.consult_rate_hit(text, text);
