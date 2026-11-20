-- "Latest data per account" dated TBC by a shop's receipt (the user, 20.11.2026):
-- a purchase uploaded from a receipt makes its own bank row (external_source
-- 'receipt_csv') until the statement brings it, and that row counted as the
-- account's newest record -- TBC showed "1 day ago" with its statement ending
-- 15.11. A receipt isn't a bank statement: those rows are left out of the
-- newest-record dates and the activity counts here (...118 / ...122 as they
-- were, with that one condition more). They still count in the balance (...216).

create or replace function public.latest_data_per_account()
returns table (account text, bank_day date, trade_day date, exchange_day date, synced_day date, bank_rows_90d integer, uploaded_to date)
language sql stable security invoker set search_path = public as $$
  with real_bank as (
    select b.account, b.tx_date from bank_transactions b
    where b.user_id = auth.uid() and b.synthetic_kind is null
      and left(coalesce(b.external_source, ''), 9) <> 'estimate_' and coalesce(b.external_source, '') not in ('openbanking_revolut_invest', 'receipt_csv')
  ),
  bank as (
    select b.account, max(b.tx_date)::date as d from real_bank b group by b.account
  ),
  act as (
    select b.account, count(*)::integer as n from real_bank b join bank on bank.account = b.account
    where b.tx_date::date between bank.d - 90 and bank.d
    group by b.account
  ),
  trd as (
    select t.account, max(t.trade_date) as d from trades t
    where t.user_id = auth.uid() and t.account is not null and coalesce(t.external_source, '') <> 'snowball_csv' and not t.estimated
    group by t.account
  ),
  exch as (
    select w.account, max(t.tx_time)::date as d from crypto_wallets w join wallet_transactions t on t.wallet_id = w.id
    where w.user_id = auth.uid() and w.chain in ('binance', 'bybit', 'cryptocom', 'telegram') and not t.estimated group by w.account
  ),
  onchain as (
    select w.account, max(w.last_synced_at)::date as d from crypto_wallets w
    where w.user_id = auth.uid() and w.chain not in ('binance', 'bybit', 'cryptocom', 'telegram') group by w.account
  ),
  upl as (
    select u.account, max(coalesce(u.period_to, u.uploaded_at::date)) as d from statement_uploads u
    where u.user_id = auth.uid() group by u.account
  ),
  accounts as (
    select account from bank union select account from trd union select account from exch union select account from onchain
  )
  select a.account, bank.d, trd.d, exch.d, onchain.d, coalesce(act.n, 0), upl.d
  from accounts a
  left join bank on bank.account = a.account left join act on act.account = a.account
  left join trd on trd.account = a.account left join exch on exch.account = a.account
  left join onchain on onchain.account = a.account left join upl on upl.account = a.account;
$$;
grant execute on function public.latest_data_per_account() to authenticated;

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
      and left(coalesce(b.external_source, ''), 9) <> 'estimate_' and coalesce(b.external_source, '') not in ('openbanking_revolut_invest', 'receipt_csv')
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
