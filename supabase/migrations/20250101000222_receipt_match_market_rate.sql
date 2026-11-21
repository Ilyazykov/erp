-- A receipt in one currency paid from an account in another, the bank's row carrying no rate
-- (Revolut's statement CSV: 23.10.2026, Magti 50 GEL paid as 17.40 EUR, fx_rate null -- the
-- receipt made a row of its own and the payment counted twice). Such a row is the receipt's too
-- when its description names the receipt's chain (match_receipts' chain_hit: "Magticom") and
-- its amount at the day's market rate (usd_per_unit_on) is within 3% of the receipt's total --
-- a card's conversion costs a little over the market (17.40 EUR is 50.64 GEL at the market).
-- Without the chain in the description a row in another currency still needs the bank's own
-- rate, as before: a payment of about the same amount elsewhere isn't taken for it.
-- The rest is as in ...179.
create or replace function public.receipt_match_candidates(p_receipt_id bigint, p_before integer default 1, p_after integer default 5, p_user uuid default null)
returns table (external_source text, external_id text, account text, chain_hit boolean, date_dist integer)
language sql stable as $$
  select b.external_source, b.external_id, b.account,
         (r.chain is not null and r.chain <> '' and b.description ilike '%' || r.chain || '%') as chain_hit,
         abs(coalesce(b.authorized_on, b.tx_date::date) - r.purchased_on) as date_dist
  from public.receipts r, public.bank_transactions b
  where r.id = p_receipt_id and r.user_id = coalesce(p_user, auth.uid())
    and b.user_id = coalesce(p_user, auth.uid()) and b.amount < 0 and not b.synthetic
    and coalesce(b.authorized_on, b.tx_date::date) between r.purchased_on - p_before and r.purchased_on + p_after
    and (
      (b.currency = r.currency and round(-b.amount, 2) = round(r.total, 2))
      or (b.currency <> r.currency and b.fx_rate is not null and abs(round(-b.amount * b.fx_rate, 2) - r.total) <= 0.02)
      or (b.currency <> r.currency and b.fx_rate is null and r.total > 0
          and r.chain is not null and r.chain <> '' and b.description ilike '%' || r.chain || '%'
          and abs(-b.amount * public.usd_per_unit_on(b.currency, coalesce(b.authorized_on, b.tx_date::date))
                  / nullif(public.usd_per_unit_on(r.currency, coalesce(b.authorized_on, b.tx_date::date)), 0) - r.total) <= r.total * 0.03)
    )
    and not exists (
      select 1 from public.receipts other
      where other.user_id = coalesce(p_user, auth.uid()) and other.source = r.source and other.id <> r.id
        and other.tx_source = b.external_source and other.tx_external_id = b.external_id
        and other.match_state in ('linked', 'manual_link')
    )
$$;
