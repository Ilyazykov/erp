-- The Snowball sale of the Telegram Wallet BTC (2025-11-15, 0.00450484 BTC,
-- no note) was left behind by 20250101000020_telegram_wallet.sql, which
-- removed only the noted buys -- so current holdings showed -0.0045048 BTC
-- under "(unspecified)". Wallet's own history has the sale ("Exchanged BTC
-- to USDT"). Removed; import-trades-csv skips it from now on.

delete from public.trades
where external_source = 'snowball_csv' and ticker = 'BTC' and side = 'sell'
  and trade_date = '2025-11-15' and quantity = 0.00450484
  and (note is null or note = '');
