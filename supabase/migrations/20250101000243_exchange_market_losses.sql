-- What a money-transfer service really lost against the market (23.11.2026). The expenses took a pair's loss at
-- the Bank of Russia's rate of the day, which is set the day before: on 05.07.2022, with the rouble falling, a
-- KoronaPay transfer of 130 320 RUB for 2 000 USD showed 365.76 $ lost at 55.09, when the Moscow Exchange traded
-- at 61.15 (131.15 $). A row here holds the loss -- the fee and the spread -- at the exchange price of the
-- transfer's minute; step 3 of refresh_expenses takes it over its own. The rows are filled on the database
-- (their keys carry account and phone numbers, not for this repo).
create table if not exists public.exchange_market_losses (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  out_source text not null,
  out_id text not null,
  market_rate numeric not null,   -- roubles per unit of what was bought, on the Moscow Exchange
  market_at timestamp not null,   -- the 10-minute candle it is from, Moscow time
  loss_amount numeric not null,   -- in the sold currency; below zero: better than the market
  loss_usd numeric not null,
  created_at timestamptz not null default now(),
  primary key (user_id, out_source, out_id)
);
alter table public.exchange_market_losses enable row level security;
drop policy if exists "own exchange market losses" on public.exchange_market_losses;
create policy "own exchange market losses" on public.exchange_market_losses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a1 text := $t$         x.loss / x.rate, x.ccy, x.loss, 'Fees', true$t$;
  b1 text := $t$         coalesce(x.market_amount, x.loss / x.rate), x.ccy, x.loss, 'Fees', true$t$;
  a2 text := $t$           it.amount as in_amount, upper(it.currency) as in_ccy,
$t$;
  b2 text := $t$           it.amount as in_amount, upper(it.currency) as in_ccy, m.loss_amount as market_amount,
$t$;
  a3 text := $t$           -o.amount * usd_per_unit_on(o.currency, o.tx_date::date)
             - it.amount * usd_per_unit_on(it.currency, it.in_at::date) as loss
    from internal_transfers it
    join bank_transactions o on o.user_id = it.user_id and o.external_source = it.out_source and o.external_id = it.out_id
$t$;
  b3 text := $t$           coalesce(m.loss_usd, -o.amount * usd_per_unit_on(o.currency, o.tx_date::date)
             - it.amount * usd_per_unit_on(it.currency, it.in_at::date)) as loss
    from internal_transfers it
    join bank_transactions o on o.user_id = it.user_id and o.external_source = it.out_source and o.external_id = it.out_id
    left join exchange_market_losses m on m.user_id = it.user_id and m.out_source = it.out_source and m.out_id = it.out_id
$t$;
begin
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0 then
    raise exception 'refresh_expenses: step 3 not as expected';
  end if;
  execute replace(replace(replace(d, a1, b1), a2, b2), a3, b3);
end $mig$;
