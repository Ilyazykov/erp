-- latest_data_per_part (...101) for Revolut too: each of its statements is a
-- part of its own -- the account statement (cards and current accounts),
-- Invest (broker), Flexible Cash Funds, savings, crypto, metals.

create or replace function public.latest_data_per_part()
returns table (account text, part text, last_day date, row_count integer, contracts text[])
language sql stable set search_path = public as $$
  with rows as (
    select b.account, b.tx_date::date as d, b.external_source as src,
      case
        when b.external_source like 'atomyze%' then 'ЦФА (Atomyze)'
        when b.product = 'credit_card' then 'Credit card'
        when b.product = 'brokerage_cash' or b.external_source ~ 'broker|invest' then 'Broker'
        when b.product in ('savings', 'deposit') then 'Deposits & savings'
        else 'Cards & current accounts'
      end as part
    from bank_transactions b
    where b.user_id = auth.uid() and b.synthetic_kind is null and b.account is not null
    union all
    select t.account, t.trade_date, t.external_source,
      case
        when t.external_source like 'atomyze%' then 'ЦФА (Atomyze)'
        when t.external_source like 'revolut_fund%' then 'Flexible Cash Funds'
        when t.external_source like '%crypto%' then 'Crypto'
        when t.external_source like '%metal%' then 'Metals'
        when t.external_source like '%deposit%' then 'Deposits & savings'
        else 'Broker'
      end
    from trades t
    where t.user_id = auth.uid() and t.account is not null and coalesce(t.external_source, '') <> 'snowball_csv'
  )
  select r.account, r.part, max(r.d), count(*)::integer,
    array_agg(distinct regexp_replace(split_part(r.src, ':', 2), '-app$', '')) filter (where split_part(r.src, ':', 2) <> '')
  from rows r
  group by r.account, r.part
$$;
