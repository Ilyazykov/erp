-- A card payment in another currency costs more than the purchase: Revolut
-- converted 40 GEL at 2.8798 per EUR, 13.89 EUR, where the market had 2.9166
-- -- 0.17 EUR, 1.3% (26 payments in Georgia, 20-28.10.2026: 3.21 EUR). The
-- rate comes with the transaction (Enable Banking's exchange_rate, kept by
-- sync-openbanking as fx_rate: the other currency per unit of the account's).
-- refresh_expenses now splits such a payment: the purchase at the market rate
-- in its category, the rest a fee ('Fees', "Lost on the exchange: ..."), on
-- the same day as the purchase. The other currency is the one whose market
-- rate that day is nearest fx_rate (within 5%) -- the bank doesn't name it.
-- refresh_expenses is patched in place (as in ...130).

alter table public.bank_transactions add column if not exists fx_rate numeric;
comment on column public.bank_transactions.fx_rate is
  'A payment converted from another currency: that currency per unit of this row''s (Revolut 2.8798 GEL per EUR); null otherwise';

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  perform refresh_income(p_user);';
  b text := $blk$  -- 4. a card payment in another currency (fx_rate, migration ...151): the
  -- part over the market rate is a fee, on the purchase's day; the purchase
  -- keeps the rest
  drop table if exists fx_fees;
  create temp table fx_fees on commit drop as
  select b.external_source, b.external_id, b.account, b.description, x.day, upper(b.currency) as ccy,
         -b.amount as amt, m.c as orig_ccy, -b.amount * b.fx_rate as orig_amt,
         -b.amount * (1 - b.fx_rate / m.mkt) as fee
  from bank_transactions b
  cross join lateral (select coalesce(b.authorized_on, b.tx_date::date) as day) x
  cross join lateral (
    select c, usd_per_unit_on(b.currency, x.day) / usd_per_unit_on(c, x.day) as mkt
    from unnest(array['USD', 'EUR', 'GBP', 'GEL', 'TRY', 'RSD', 'RUB', 'AED', 'CNY', 'HUF', 'ILS']) c
    where c <> upper(b.currency) and usd_per_unit_on(c, x.day) > 0
    order by abs(ln(b.fx_rate * usd_per_unit_on(c, x.day) / usd_per_unit_on(b.currency, x.day)))
    limit 1
  ) m
  where b.user_id = p_user and b.amount < 0 and b.fx_rate > 0
    and abs(ln(b.fx_rate / m.mkt)) < 0.05;

  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted)
  select p_user, f.day, f.day, f.account, f.external_source, f.external_id,
         'Lost on the exchange: ' || f.description || ' -> ' || round(f.orig_amt, 2) || ' ' || f.orig_ccy,
         f.fee, f.ccy, f.fee * usd_per_unit_on(f.ccy, f.day), 'Fees', true
  from fx_fees f
  where f.fee > 0 and exists (
    select 1 from expenses e where e.user_id = p_user and e.external_source = f.external_source
      and e.external_id = f.external_id and e.counted and e.amount = f.amt);

  update expenses e set amount = e.amount - f.fee, usd = e.usd * (1 - f.fee / f.amt)
  from fx_fees f
  where e.user_id = p_user and f.fee > 0 and e.external_source = f.external_source
    and e.external_id = f.external_id and e.counted and e.amount = f.amt and e.category <> 'Fees';

  perform refresh_income(p_user);$blk$;
begin
  if position('fx_rate, migration ...151' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: refresh_income call not found'; end if;
  execute replace(d, a, b);
end $mig$;
