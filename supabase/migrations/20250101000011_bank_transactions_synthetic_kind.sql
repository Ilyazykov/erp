-- Machine-readable detail for synthetic bank_transactions rows (see
-- 20250101000010_bank_transactions_synthetic.sql), so downstream code can
-- recognise them and e.g. draw a known data gap differently on charts
-- instead of just skipping `synthetic` rows:
--
--   synthetic_kind = 'data_gap'        -- statements run out here: the row
--                                         zeroes the balance and nothing is
--                                         known from tx_date until
--                                         data_gap_until
--   synthetic_kind = 'account_closed'  -- account closed on tx_date, amount 0
--
-- Real transactions have synthetic_kind null. The checks keep the three
-- columns consistent: synthetic <=> kind set, and data_gap_until only (and
-- always) on a 'data_gap' row.

alter table public.bank_transactions
  add column synthetic_kind text
    check (synthetic_kind in ('data_gap', 'account_closed')),
  add column data_gap_until date;

-- Synthetic rows already imported before this column existed (UniCredit):
-- the zero-amount one is the closure mark; the other is the gap, which runs
-- until that same account's closure mark.
update public.bank_transactions
set synthetic_kind = 'account_closed'
where synthetic and amount = 0;

update public.bank_transactions g
set synthetic_kind = 'data_gap',
    data_gap_until = (
      select min(c.tx_date)::date
      from public.bank_transactions c
      where c.user_id = g.user_id
        and c.external_source = g.external_source
        and c.synthetic_kind = 'account_closed'
        and c.tx_date > g.tx_date
    )
where synthetic and synthetic_kind is null;

alter table public.bank_transactions
  add constraint bank_transactions_synthetic_kind_consistent
    check (synthetic = (synthetic_kind is not null)),
  add constraint bank_transactions_data_gap_until_consistent
    check (case when synthetic_kind = 'data_gap' then data_gap_until is not null
                else data_gap_until is null end);
