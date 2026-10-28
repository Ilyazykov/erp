-- A currency that came into a bank account and left it the same day (TBC:
-- 1000 EUR put in 28.10.2026 and exchanged to lari within the hour) never had
-- a value at a day's end, so capital_daily -- and with it capital_ever_held --
-- never saw it, and the broker x currency table showed its zero dim. Any real
-- bank row now counts too, under the ticker capital_daily gives a bank
-- balance (CASH:<currency>:<product>).

create or replace function public.refresh_capital_ever_held(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from capital_ever_held_cache where user_id = p_user;
  insert into capital_ever_held_cache (user_id, account, ticker, currency, instrument_type)
  select p_user, account, ticker, max(currency), max(instrument_type)
  from (
    select account, ticker, currency, instrument_type from capital_daily
    where user_id = p_user and abs(value_usd) >= 0.01
    union all
    select w.account, t.symbol, null, 'crypto' from wallet_transactions t join crypto_wallets w on w.id = t.wallet_id
    where t.user_id = p_user and t.symbol is not null
    union all
    select b.account, 'CASH:' || upper(b.currency) || ':' || coalesce(b.product, ''), upper(b.currency),
           case when b.product = 'credit_card' then 'credit' else 'cash' end
    from bank_transactions b
    where b.user_id = p_user and not b.synthetic and b.amount <> 0
      and upper(b.currency) not in ('XAU', 'XAG', 'XPT', 'XPD')
  ) x
  group by account, ticker;
end $$;
revoke all on function public.refresh_capital_ever_held(uuid) from public, anon, authenticated;

select refresh_capital_ever_held(u.user_id)
from (select distinct user_id from bank_transactions) u;
