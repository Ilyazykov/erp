-- What an exchange within one bank lost, in the expenses too (asked 23.11.2026): Ziraat's dollars
-- sold for lira at ~3% under the market on an evening or a weekend (22.11.2026, 17:16, a Sunday:
-- 1 757.03 USD for 86 199.72 TRY, ~52 $ lost). Only a pair from one currency into another that
-- internal_transfers matched (step 3 of refresh_expenses) had its loss there; an exchange in a bank's
-- app -- two rows of one bank on one day, the view currency_exchanges' kind 'exchange' (560 of them,
-- ~1 140 $) -- had none. Now its loss -- what was sold less what was bought, at their day's rates --
-- is a 'Fees' row on the sold row's day, like step 3's: not a gain, nor past a third.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a1 text := E'  where x.loss > 0 and x.loss <= x.out_usd / 3;\n\n  update expenses e set extrapolated = true';
  a2 text := $t$  where x.loss > 0 and x.loss <= x.out_usd / 3;

  -- 3b. an exchange within a bank (currency_exchanges' 'exchange': its two rows of a day, no transfer
  -- pair): what it lost the same way, on the sold row
  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted)
  select p_user, c.at::date, c.at::date, b.account, b.external_source, b.external_id,
         'Lost on the exchange: ' || b.description || ' -> ' || round(c.bought_amount, 2) || ' ' || c.bought_ccy,
         (c.sold_usd - c.bought_usd) / usd_per_unit_on(c.sold_ccy, c.at::date), c.sold_ccy, c.sold_usd - c.bought_usd, 'Fees', true
  from currency_exchanges c
  join bank_transactions b on b.user_id = c.user_id and b.external_source = c.out_source and b.external_id = c.out_id
  where c.user_id = p_user and c.kind = 'exchange'
    and c.sold_usd > c.bought_usd and c.sold_usd - c.bought_usd <= c.sold_usd / 3;

  update expenses e set extrapolated = true$t$;
begin
  if position(a1 in d) = 0 then raise exception 'refresh_expenses: the end of step 3 not found'; end if;
  execute replace(d, a1, a2);
end $mig$;

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
