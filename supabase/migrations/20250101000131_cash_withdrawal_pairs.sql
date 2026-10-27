-- Cash taken out of a bank into the cash on hand: the bank's row out and the
-- cash ledger's row in (cash_csv:on_hand, "Cash withdrawn ...") are one move.
-- match_internal_transfers pairs only the same currency, so a withdrawal in
-- another currency than the account's (lira from a rouble or dollar card in
-- Antalya, ...) stayed unpaired -- and counted as money spent on the expenses
-- tab, while what the cash bought is in the ledger too. The ledger's rows carry
-- the bank row's own time, so they pair by it: same minute, one to one (several
-- in the same minute in the order of their ids). ATM fees stay out.
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
with o as (
  select b.*, row_number() over (partition by b.user_id, b.tx_date order by b.external_id) as n
  from bank_transactions b
  where b.amount < 0 and b.account <> 'cash' and b.tx_date >= '2022-02-24'
    and b.description ~* 'cash withdrawal|cash withdrawn|withdrawn in cash|снятие наличных|выдача наличных|\yatm\y|банкомат|bankomat|para çekme|nakit çekim|isplata gotovine'
    and b.description !~* '\yfee\y|bsmv|komisyon|комисси|KORONAPAY|QIWI|YooMoney|Unistream'
    and not exists (select 1 from internal_transfers x where x.user_id = b.user_id
                    and x.out_source = b.external_source and x.out_id = b.external_id)
),
i as (
  select c.*, row_number() over (partition by c.user_id, c.tx_date order by c.external_id) as n
  from bank_transactions c
  where c.account = 'cash' and c.external_source = 'cash_csv:on_hand' and c.amount > 0
    and not exists (select 1 from internal_transfers x where x.user_id = c.user_id
                    and x.in_source = c.external_source and x.in_id = c.external_id)
)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual'
from o join i on i.user_id = o.user_id and i.tx_date = o.tx_date and i.n = o.n
on conflict do nothing;

-- Two from UniCredit with no statement for the day, the ledger's row the same
-- day: 13.02.2024 at Dubai airport (dollars), 08.04.2024 on coming back to Serbia.
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
select o.user_id, o.external_source, o.external_id, c.external_source, c.external_id, c.amount, c.currency, o.tx_date, c.tx_date, 'manual'
from bank_transactions o
join bank_transactions c on c.user_id = o.user_id and c.account = 'cash' and c.external_source = 'cash_csv:on_hand'
  and c.amount > 0 and c.tx_date::date = o.tx_date::date and c.description ~ '^Cash withdrawn from UniCredit'
where o.account = 'UniCredit' and o.amount < 0 and o.tx_date::date in ('2024-02-13', '2024-04-08')
  and o.description ~ '^(Cash withdrawn at an ATM|Withdrawn in cash)'
  and not exists (select 1 from internal_transfers x where x.out_source = o.external_source and x.out_id = o.external_id)
  and not exists (select 1 from internal_transfers x where x.in_source = c.external_source and x.in_id = c.external_id)
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where external_source = 'cash_csv:on_hand') u;
