-- latest_data_per_part (...101-...104): the ЦФА synced through the T-Invest
-- API go to the ЦФА part -- their money under the Atomyze wallet
-- ('tbank_api:<wallet>', a key that isn't all digits like an agreement's),
-- their trades by the "CFA:" ticker (the app rows' too, which were counted
-- as the broker's).

create or replace function public.latest_data_per_part()
returns table (account text, part text, label text, last_day date, row_count integer, contracts text[])
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
      end as what
    from bank_transactions b
    where b.user_id = auth.uid() and b.synthetic_kind is null and b.account is not null
    union all
    select t.account, t.trade_date, t.external_source,
      case
        when t.external_source like 'atomyze%' or t.ticker like 'CFA:%' then 'ЦФА (Atomyze)'
        when t.external_source like 'revolut_fund%' then 'Flexible Cash Funds'
        when t.external_source like '%crypto%' then 'Crypto'
        when t.external_source like '%metal%' then 'Metals'
        when t.external_source like '%deposit%' then 'Deposits & savings'
        else 'Broker'
      end,
      null
    from trades t
    where t.user_id = auth.uid() and t.account is not null and coalesce(t.external_source, '') <> 'snowball_csv'
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
    array_agg(distinct regexp_replace(split_part(r.src, ':', 2), '-app$', '')) filter (where split_part(r.src, ':', 2) <> '')
  from rows r left join names n on n.account = r.account
  group by r.account, r.part, n.label
$$;
