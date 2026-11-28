-- The Revolut card's charge of a Crypto.com purchase by Apple Pay, estimated until the bank has it
-- (28.11.2026): the purchases of 27.11.2026 (BTC 373.82, ETH 87.38, SOL 4.85, TAO 4.85 EUR) were in
-- Crypto.com's export at once, the card's charges (385, 90, 5, 5 EUR) still pending -- in neither
-- the combined report nor Open Banking -- so the coins counted and the euros they were paid with
-- too. Now each such purchase with no charge of it in the bank yet is a stand-in row of the
-- Revolut account, source estimate_card:cryptocom, its own running minus as its balance (as the
-- receipts' rows, migration ...216): rebuilt on every capital refresh, a purchase's row gone as
-- soon as a Crypto.com charge of it comes (the statement, Open Banking or the report: the same
-- currency, the amount within 3% / 0.50 (the fee was 3.8% on 18.11.2026: 156.08 -> 162, 28.89 -> 30), from the day before the purchase to 14 days after).
-- The charge: the purchase's price in the native currency (the export's "Native Amount", kept at
-- the end of the row's status by import-crypto-com) plus Crypto.com's 2.99% card fee, rounded up
-- to the cent -- 373.82 -> 385.00, 87.38 -> 90.00, 4.85 -> 5.00 (27.11.2026). The card is taken to
-- be Revolut's: the purchases by card so far were all paid by it.

create or replace function public.refresh_card_estimates(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  p record;
  hit uuid;
  used uuid[] := '{}';
  charge numeric;
  n integer := 0;
begin
  delete from bank_transactions where user_id = p_user and external_source = 'estimate_card:cryptocom';
  for p in
    select t.tx_hash, t.tx_time, t.symbol, t.amount, split_part(t.status, ' | ', 2) as what,
           (regexp_match(t.status, ' \| ([0-9]+(?:\.[0-9]+)?) ([A-Z]{3})$'))[1]::numeric as cost,
           (regexp_match(t.status, ' \| ([0-9]+(?:\.[0-9]+)?) ([A-Z]{3})$'))[2] as ccy
    from wallet_transactions t
    where t.user_id = p_user and t.chain = 'cryptocom' and not t.estimated and t.kind = 'trade' and t.amount > 0
      and t.status ~ '^trading\.crypto_purchase\.(apple_pay|google_pay|card) \| .* \| [0-9]+(\.[0-9]+)? [A-Z]{3}$'
      and t.tx_time > now() - interval '60 days'
    order by t.tx_time
  loop
    charge := round(ceil(p.cost * 1.0299 * 100) / 100, 2);
    select b.id into hit
    from bank_transactions b
    where b.user_id = p_user and b.account = 'Revolut' and b.external_source not like 'estimate_%'
      and upper(b.currency) = p.ccy and b.amount < 0 and b.description ~* 'crypto\.com'
      and abs(-b.amount - charge) <= greatest(0.5, charge * 0.03)
      and coalesce(b.authorized_on, b.tx_date::date) between p.tx_time::date - 1 and p.tx_time::date + 14
      and not (b.id = any (used))
    order by abs(coalesce(b.authorized_on, b.tx_date::date) - p.tx_time::date), b.tx_date
    limit 1;
    if hit is not null then
      used := used || hit;
      continue;
    end if;
    insert into bank_transactions (user_id, account, tx_date, description, amount, currency, balance_after,
                                   synthetic, amount_approximate, note, external_source, external_id)
    values (p_user, 'Revolut', p.tx_time, 'ESTIMATED: Crypto.com, ' || p.what, -charge, p.ccy, 0,
            false, true,
            'ESTIMATED: the Revolut card''s charge of a Crypto.com purchase by Apple Pay (' || p.cost || ' ' || p.ccy
              || ' + 2.99%), until the bank has it',
            'estimate_card:cryptocom', 'cdc:' || p.tx_hash);
    n := n + 1;
  end loop;
  -- the source's own running minus, per currency
  update bank_transactions b set balance_after = r.bal
  from (select id, sum(amount) over (partition by upper(currency) order by tx_date, id) as bal
        from bank_transactions where user_id = p_user and external_source = 'estimate_card:cryptocom') r
  where b.id = r.id;
  return n;
end $$;

-- run with the expenses, before the pairs are matched: on every capital refresh (an upload asks for one)
do $mig$
declare
  d text := pg_get_functiondef('public.run_capital_refresh_step()'::regprocedure);
  a text := $t$    if q.expenses_at is null or q.expenses_at < q.requested_at then
      perform match_internal_transfers(q.user_id);$t$;
  b text := $t$    if q.expenses_at is null or q.expenses_at < q.requested_at then
      perform refresh_card_estimates(q.user_id);  -- migration ...275
      perform match_internal_transfers(q.user_id);$t$;
begin
  if position('migration ...275' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'run_capital_refresh_step: the expenses step not found'; end if;
  execute replace(d, a, b);
end $mig$;
