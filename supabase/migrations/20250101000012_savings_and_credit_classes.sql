-- Two new asset-class columns in the broker x asset-class table:
--
-- liquid ("liquid assets") -- money that can be taken out at any time without losing
--   anything: on-demand savings accounts (Yandex "Сейв", T-Bank / Alfa /
--   Ozon накопительные счета, Revolut Instant Access Savings) and Revolut's
--   money-market funds. Term deposits whose early withdrawal loses interest
--   (T-Bank "Т16%13", Sber вклады) stay 'deposit'. Savings accounts get
--   their own synthetic ticker prefix "SAVINGS:<bank> <currency>" (vs
--   "DEPOSIT:..."), which update-market-prices classifies as
--   instrument_type 'liquid' / asset_class 'savings_account' (money-market
--   funds: instrument_type 'liquid', asset_class stays 'money_market_fund').
--
-- credit -- credit card balances (never positive in that column). Cash
--   rows come from bank_transactions, which until now didn't record what
--   kind of account a row belongs to; `product` (the import CSV's own
--   column: 'credit_card', 'debit_card', 'current_account', ...) fixes that.

alter table public.bank_transactions add column product text;

-- Credit cards already imported before `product` existed.
update public.bank_transactions
set product = 'credit_card'
where external_source in (
  't_bank_csv:45502810100011788467',
  'sber_csv:40817810600150721932',
  'ozon_bank_csv:2026-01-07-KK-00203707038256038702'
);

-- Savings accounts already imported under the DEPOSIT: prefix. Their
-- external_id is unchanged, so re-importing the same CSV later just
-- upserts onto these rows.
update public.trades
set ticker = 'SAVINGS:' || substring(ticker from length('DEPOSIT:') + 1)
where ticker in ('DEPOSIT:Yandex Bank RUB', 'DEPOSIT:T-Bank RUB', 'DEPOSIT:Alfa RUB', 'DEPOSIT:Ozon Bank RUB')
   or ticker like 'DEPOSIT:Revolut %';

-- Their old price rows would otherwise linger; the new SAVINGS: tickers
-- are priced on the next update-market-prices run.
delete from public.market_prices
where ticker in ('DEPOSIT:Yandex Bank RUB', 'DEPOSIT:T-Bank RUB', 'DEPOSIT:Alfa RUB', 'DEPOSIT:Ozon Bank RUB')
   or ticker like 'DEPOSIT:Revolut %';
