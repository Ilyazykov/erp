-- currency_exchanges (...226): a transfer paired with several on the other side is one exchange
-- (06.11.2026: TBC's -320 GEL paired by hand with Sber's +1 000 and +9 050 RUB from the same person --
-- one exchange, 320 GEL for 10 050 RUB, 81.6 RUB a dollar; the view took them for two, 320 GEL for
-- 9 050 RUB drawn at 73 a dollar, the other left out as too far from any rate). The rest as in ...226.
create or replace view public.currency_exchanges
with (security_invoker = true) as
with fiat as (select distinct currency as c from public.fx_history union select 'USD'),
free as (
  select b.* from public.bank_transactions b
  where not b.synthetic and b.amount <> 0 and b.description !~* '^removed'
    and upper(b.currency) in (select c from fiat)
    and not exists (select 1 from public.internal_transfers x where x.user_id = b.user_id and x.matched_by <> 'rejected'
      and ((x.out_source = b.external_source and x.out_id = b.external_id) or (x.in_source = b.external_source and x.in_id = b.external_id)))
),
same as (
  select o.user_id, o.tx_date as at, upper(o.currency) as sold_ccy, abs(o.amount) as sold_amount, upper(i.currency) as bought_ccy,
    i.amount as bought_amount, o.account || ': ' || o.description as how,
    abs(ln(abs(o.amount) * public.usd_per_unit_on(o.currency, o.tx_date::date)
      / nullif(i.amount * public.usd_per_unit_on(i.currency, i.tx_date::date), 0))) as gap,
    abs(extract(epoch from i.tx_date - o.tx_date)) as dt, o.id as oid, i.id as iid
  from free o
  join free i on i.user_id = o.user_id and split_part(i.external_source, ':', 1) = split_part(o.external_source, ':', 1)
    and i.description = o.description and upper(i.currency) <> upper(o.currency) and i.amount > 0
    and i.tx_date::date = o.tx_date::date
  where o.amount < 0
),
same_ranked as (
  select *, row_number() over (partition by oid order by dt, gap) as ro, row_number() over (partition by iid order by dt, gap) as ri
  from same where gap < 0.08
),
pairs as (
  select it.user_id, it.out_at as at, it.out_source || '|' || it.out_id as okey, it.in_source || '|' || it.in_id as ikey,
    upper(o.currency) as sold_ccy, abs(o.amount) as sold_amount, upper(i.currency) as bought_ccy, abs(i.amount) as bought_amount,
    case when o.account = i.account then o.account || ': ' || o.description else o.account || ' -> ' || i.account end as how
  from public.internal_transfers it
  join public.bank_transactions o on o.user_id = it.user_id and o.external_source = it.out_source and o.external_id = it.out_id
  join public.bank_transactions i on i.user_id = it.user_id and i.external_source = it.in_source and i.external_id = it.in_id
  where it.matched_by <> 'rejected' and upper(o.currency) <> upper(i.currency)
    and upper(o.currency) in (select c from fiat) and upper(i.currency) in (select c from fiat)
),
-- one out paired with several ins (TBC's 320 GEL -> 1 000 + 9 050 RUB) is one exchange: the ins summed;
-- several outs into one in likewise
multi_out as (select okey from pairs group by okey having count(*) > 1),
alls as (
  select user_id, min(at) as at, sold_ccy, max(sold_amount) as sold_amount, bought_ccy, sum(bought_amount) as bought_amount,
    min(how) as how, 'transfer'::text as kind
  from pairs where okey in (select okey from multi_out)
  group by user_id, okey, sold_ccy, bought_ccy
  union all
  select user_id, min(at), sold_ccy, sum(sold_amount), bought_ccy, max(bought_amount), min(how), 'transfer'
  from pairs where okey not in (select okey from multi_out)
  group by user_id, ikey, sold_ccy, bought_ccy
  union all
  select user_id, at, sold_ccy, sold_amount, bought_ccy, bought_amount, how, 'exchange' from same_ranked where ro = 1 and ri = 1
  union all
  select t.user_id, t.trade_date::timestamptz,
    upper(case when t.side = 'buy' then t.currency else m.underlying_currency end),
    case when t.side = 'buy' then t.quantity * t.price
      else t.quantity * t.price * public.usd_per_unit_on(t.currency, t.trade_date) / public.usd_per_unit_on(m.underlying_currency, t.trade_date) end,
    upper(case when t.side = 'buy' then m.underlying_currency else t.currency end),
    case when t.side = 'buy' then t.quantity * t.price * public.usd_per_unit_on(t.currency, t.trade_date) / public.usd_per_unit_on(m.underlying_currency, t.trade_date)
      else t.quantity * t.price end,
    coalesce(t.account, t.external_source) || ': ' || t.side || ' ' || t.ticker, 'fund'
  from public.trades t
  join public.market_prices m on m.ticker = t.ticker
  where t.side in ('buy', 'sell') and t.quantity * t.price > 0
    and upper(m.currency) = upper(t.currency) and upper(coalesce(m.underlying_currency, t.currency)) <> upper(t.currency)
    and upper(t.currency) in (select c from fiat) and upper(m.underlying_currency) in (select c from fiat)
    and m.instrument_type not in ('stock', 'gold') and m.asset_class is distinct from 'crypto'
)
select * from (
  select user_id, at, sold_ccy, sold_amount, sold_amount * public.usd_per_unit_on(sold_ccy, at::date) as sold_usd,
    bought_ccy, bought_amount, bought_amount * public.usd_per_unit_on(bought_ccy, at::date) as bought_usd, how, kind
  from alls
) e
-- a pair whose sides are worlds apart is no exchange at a rate; a card's lira from a Turkish ATM in 2022
-- (up to 17% off) stays
where sold_usd > 0 and bought_usd > 0 and abs(ln(sold_usd / bought_usd)) < 0.5;

grant select on public.currency_exchanges to authenticated;
