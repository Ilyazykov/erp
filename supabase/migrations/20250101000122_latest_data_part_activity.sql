-- latest_data_per_part (...118) also counts each part's real records over the
-- last 90 and 180 days: the page sets how often a part wants a fresh
-- statement from how active it is (index.html, "Latest data per account").
-- Income that comes by itself -- dividends, coupons, a fund's daily return
-- and fee, interest credited or capitalised -- says nothing of the account
-- being used: left out of those two counts.
-- The return type changes, so the function is dropped and made again.

drop function if exists public.latest_data_per_part();
create function public.latest_data_per_part()
returns table (account text, part text, label text, last_day date, row_count integer, contracts text[], rows_90d integer, rows_180d integer)
language sql stable set search_path = public as $$
  with rows as (
    select b.account, b.tx_date::date as d, b.external_source as src,
      case
        when b.external_source like 'atomyze%' or b.external_source ~ '^tbank_api:\D' then 'ЦФА (Atomyze)'
        when b.product = 'credit_card' then 'Credit card'
        when b.product = 'brokerage_cash' or b.external_source ~ 'broker|invest|tbank_api' then 'Broker'
        when b.product in ('savings', 'deposit') then 'Deposits & savings'
        else 'Cards & current accounts'
      end as part,
      case
        when split_part(b.external_source, ':', 2) = 'wallet' then 'wallet'
        when b.product = 'debit_card' then 'card'
        when b.product in ('current_account', 'current') then 'current'
      end as what,
      coalesce(b.description, '') ~* '(interest|процент|капитализ|dividend|дивиденд|coupon|купон)' as income
    from bank_transactions b
    where b.user_id = auth.uid() and b.synthetic_kind is null and b.account is not null
      and left(coalesce(b.external_source, ''), 9) <> 'estimate_' and coalesce(b.external_source, '') <> 'openbanking_revolut_invest'
    union all
    select t.account, t.trade_date, t.external_source,
      case
        when t.external_source like 'atomyze%' or t.ticker like 'CFA:%' then 'ЦФА (Atomyze)'
        when t.external_source like '%revolut_fund%' then 'Flexible Cash Funds'
        when t.external_source like '%revolut_savings%' then 'Deposits & savings'
        when t.external_source like '%crypto%' then 'Crypto'
        when t.external_source like '%metal%' then 'Metals'
        when t.external_source like '%deposit%' then 'Deposits & savings'
        else 'Broker'
      end,
      null,
      t.side = 'dividend' or coalesce(t.note, '') ~* '(interest|процент|капитализ)'
    from trades t
    where t.user_id = auth.uid() and t.account is not null and coalesce(t.external_source, '') <> 'snowball_csv' and not t.estimated
  ),
  kinds as (
    select r.account, r.what, count(distinct split_part(r.src, ':', 2)) as n
    from rows r where r.part = 'Cards & current accounts' and r.what is not null
    group by r.account, r.what
  ),
  names as (
    select k.account, string_agg(
      case k.what
        when 'wallet' then case when k.n > 1 then 'Wallets' else 'Wallet' end
        when 'card' then case when k.n > 1 then 'Debit cards' else 'Debit card' end
        else case when k.n > 1 then 'current accounts' else 'current account' end
      end, ' & ' order by case k.what when 'wallet' then 1 when 'card' then 2 else 3 end) as label
    from kinds k group by k.account
  )
  select r.account, r.part,
    case when r.part = 'Cards & current accounts'
      then coalesce(upper(left(n.label, 1)) || substr(n.label, 2), 'Account') else r.part end,
    max(r.d), count(*)::integer,
    array_agg(distinct regexp_replace(split_part(r.src, ':', 2), '-app$', '')) filter (where split_part(r.src, ':', 2) <> ''),
    (count(*) filter (where r.d > current_date - 90 and not r.income))::integer,
    (count(*) filter (where r.d > current_date - 180 and not r.income))::integer
  from rows r left join names n on n.account = r.account
  group by r.account, r.part, n.label
$$;
grant execute on function public.latest_data_per_part() to authenticated;
