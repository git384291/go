-- 0036 롤백: 계정 누적을 평생 합계(0021)로, 월 판정 한도를 월 예산만(0034)으로 되돌린다. 원장·예약 기록은 건드리지 않는다.
begin;

create or replace function core.ad_account_total() returns int
language sql stable set search_path = '' as $$
  select (coalesce((select sum(x.max_krw) from core.ad_exposure x), 0)
        + coalesce((select sum(l.amount_krw) from core.ad_spend_ledger l
                    where not exists (select 1 from core.ad_exposure x where x.request_key = l.request_key)), 0))::int
$$;

create or replace function core.ad_month_effective_limit() returns int
language sql stable set search_path = '' as $$
  select coalesce((select (c.monthly_limit_krw::bigint * (100 - c.margin_pct) / 100)::int from core.ad_month_config c where c.id = 1), 0)
$$;

commit;
