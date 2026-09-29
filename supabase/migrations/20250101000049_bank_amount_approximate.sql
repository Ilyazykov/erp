-- A real transaction whose amount isn't known exactly: it certainly
-- happened (a receipt-less cash purchase remembered from photos, a Booking
-- stay paid on the spot in another currency), but the amount is an
-- estimate (typical prices of the time, a rate of the day). Set from the
-- bank CSV's optional `amount_approximate` column (import-bank-csv); counts
-- like any other transaction, the flag only says not to trust the cents.

alter table public.bank_transactions
  add column amount_approximate boolean not null default false;
