-- What came after ...127 and ...128 were applied.
--
-- life_periods: a period with no end is where one still is (the expenses tab
-- takes it to today).
alter table public.life_periods alter column end_day drop not null;
alter table public.life_periods drop constraint life_periods_check;
alter table public.life_periods add constraint life_periods_check check (end_day is null or end_day >= start_day);

-- Two more exchanges paired by hand, as in ...127, and a balance moved out and back.
-- Dollars out of Revolut to a P2P exchanger 10.10.2025 20:24 UTC, the
-- roubles in T-Bank by SBP an hour later (82 RUB/USD).
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual'
from bank_transactions o
join bank_transactions i on i.user_id = o.user_id and i.account = 'T-Bank' and i.currency = 'RUB' and i.amount = 16000
  and i.tx_date between o.tx_date and o.tx_date + interval '2 hours' and i.description ~ '^Replenishment by phone number'
where o.account = 'Revolut' and o.currency = 'USD' and o.amount = -195.2 and o.tx_date::date = '2025-10-10'
on conflict do nothing;

-- T-Bank's dollar and euro accounts sold into the rouble card (contract
-- 5040156423) 04.07.2022, the roubles in the same minute, then sent to Turkey
-- through KoronaPay.
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual'
from (values (-3200::numeric, 'USD', 177280::numeric), (-1560.75, 'USD', 78427.69), (-6796.08, 'EUR', 357134)) v(out_amt, ccy, rub)
join bank_transactions o on o.account = 'T-Bank' and o.currency = v.ccy and o.amount = v.out_amt
  and o.tx_date::date = '2022-07-04' and o.description ~ '^Внутренний перевод на договор 5040156423'
join bank_transactions i on i.user_id = o.user_id and i.account = 'T-Bank' and i.currency = 'RUB' and i.amount = v.rub
  and i.tx_date::date = '2022-07-04' and i.description ~ '^Intrabank transfer from contract'
on conflict do nothing;

-- Ziraat 17.03.2023, "Müşteri Skont Devri": the whole balance of each account
-- taken out and put straight back the same day (the card was replaced) -- not
-- money spent. Same account and currency, so match_internal_transfers, which
-- pairs only different accounts, leaves it.
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual'
from bank_transactions o
join bank_transactions i on i.user_id = o.user_id and i.external_source = o.external_source
  and i.currency = o.currency and i.amount = -o.amount and i.description = o.description
  and i.tx_date::date = o.tx_date::date
where o.account = 'Ziraat Bank' and o.description = 'Müşteri Skont Devri' and o.amount < 0
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where description = 'vlasova.ekat') u;
