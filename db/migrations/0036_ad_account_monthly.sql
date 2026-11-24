-- 0036 계정 누적 광고비 3만원: 평생 누적 → 한국 시간 월별(PM 11/25 승인). 가상 DB 시험만, 실제 광고 API·광고비 없음.
-- - core.ad_account_total(): 이번 달(KST) 1일 이후 날짜의 최대 청구 가능액 합. 지난달 이전 지출은 세지 않는다(다음 달에 광고가 막히던 문제 해결).
--   이번 달 이후(다음 달 날짜 포함) 예약은 센다 → 월말 집행 기간이 다음 달로 넘어가도 보수적으로 판정(초과 방향으로 열리지 않음).
-- - 월 판정 한도 = least(월 예산 × (100 − 안전 여유)%, 계정 월 3만원). 집행 기간이 걸친 달마다 따로 판정(0034 ad_month_check).
-- - 그대로: 월 예산 기본 0원(= 집행 금지), 캠페인 일 1만·3일 3만, 계정 일 1만, 계정 잠금 직렬화.
begin;

create or replace function core.ad_account_total() returns int
language sql stable set search_path = '' as $$
  with s as (select date_trunc('month', now() at time zone 'Asia/Seoul')::date as d)
  select (coalesce((select sum(x.max_krw) from core.ad_exposure x, s where x.serve_date >= s.d), 0)
        + coalesce((select sum(l.amount_krw) from core.ad_spend_ledger l, s
                    where l.spend_date >= s.d and not exists (select 1 from core.ad_exposure x where x.request_key = l.request_key)), 0))::int
$$;

create or replace function core.ad_month_effective_limit() returns int
language sql stable set search_path = '' as $$
  select least(coalesce((select (c.monthly_limit_krw::bigint * (100 - c.margin_pct) / 100)::int from core.ad_month_config c where c.id = 1), 0), 30000)
$$;

commit;
