-- Every transaction in one of three: spending, income, or a pair that nets out
-- (asked for 03.11.2026).
--
-- 1. A refund takes off the spending it gives back: money in that answers a
--    purchase that was spending (not a trade, an exchange, a transfer of one's
--    own) -- the same merchant (the description less "Refund from" /
--    "Refund transaction in" / "Payment in"), the same account and currency,
--    at most 120 days after, no more than it cost -- is kept as refund_of (the
--    purchase's source|id) and goes into the expenses as a negative row in the
--    purchase's category ("Refund: Eurostar", -154 EUR in Travel). A row that
--    says it's a refund but answers no purchase found takes the category of
--    the merchant's latest purchase anywhere, else Other. Not income then:
--    refresh_income leaves refund_of rows out.
-- 2. transfer_pairs(from, to): the pairs of internal_transfers with both legs
--    (out and in, from bank_transactions or the savings / deposit trades) --
--    the page's "Not counted" shows each as the two rows that net out.
--    unpaired_in(from, to): money in that's no income, no refund, no pair's leg
--    (an exchange's leg the matcher didn't pair, a fund's payout).
-- 3. Coupons and interest are income, each its own kind, dividends not (asked
--    for 03.11.2026): the rows in by income_rules; the interest a savings account
--    or a deposit pays, kept only as its trades, and the Revolut funds' return
--    by refresh_income itself.
-- refresh_expenses / refresh_income are patched in place (as in ...130).

alter table public.bank_transactions add column if not exists refund_of text;
-- set by hand: the refund the words can't tie to its purchase (a friend's share
-- of a bill sent by Revolut, "Revolut Bank UAB"), kept through the rebuilds
alter table public.bank_transactions add column if not exists refund_manual boolean not null default false;
-- 07.04.2026 Iaroslav Khnygin's 28.46 £ "For Scudamore's Punting Company": the
-- split bill of the 68 £ of 06.04 (the user, 03.11.2026)
update public.bank_transactions set refund_of = 'revolut_csv|2026-04-06 16:25:22:Scudamore''s Punting Company:-68:GBP', refund_manual = true
where external_source = 'revolut_csv' and external_id = '2026-04-07 08:25:10:Revolut Bank UAB:28.46:GBP';
-- 24.04.2023 Evgeniia Andolshchik's 202 TRY: the 200 TRY sent her that day back
-- (the user, 03.11.2026: "считай возвратом")
update public.bank_transactions set refund_of = 'ziraat_xlsx|24.04.2023:F25205:EVGENIIA ANDOLSHCHIK Ziraat Mobil Havale:-200', refund_manual = true
where external_source = 'ziraat_xlsx' and external_id = '24.04.2023:F25009:EVGENIIA ANDOLSHCHIK Ziraat Mobil Havale:202';

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  perform refresh_income(p_user);';
  b text := $blk$  -- 5. refunds (migration ...155): money in answering a purchase takes it off
  update bank_transactions set refund_of = null where user_id = p_user and refund_of is not null and not refund_manual;
  drop table if exists refund_rows;
  create temp table refund_rows on commit drop as
  select b.id, b.external_source, b.external_id, b.account, upper(b.currency) as ccy, b.amount,
         coalesce(b.authorized_on, b.tx_date::date) as day, b.description,
         trim(regexp_replace(lower(regexp_replace(b.description, '^\s*(refund (from|transaction in|of payment for goods by)|возврат( покупки)?:?|payment in|оплата в)\s+', '', 'i')),
           '[^[:alnum:]]+', ' ', 'g')) as merch,
         b.description ~* '\m(refund|возврат|reversal|chargeback|iade)' as says_refund
  from bank_transactions b
  -- (income_category not looked at: the last run's catch-all Other took the refunds
  -- with no "refund" in them -- refresh_income runs after this and leaves them out)
  where b.user_id = p_user and b.amount > 0 and not b.synthetic and not b.income_manual
    and coalesce(b.income_category, '') not in ('Salary', 'Flat rent', 'Cashback')
    and not exists (select 1 from internal_transfers x where x.user_id = p_user and x.matched_by <> 'rejected'
                    and x.in_source = b.external_source and x.in_id = b.external_id);

  update bank_transactions b set refund_of = m.ref
  from (
    select distinct on (r.id) r.id, o.external_source || '|' || o.external_id as ref
    from refund_rows r
    join bank_transactions o on o.user_id = p_user and o.account = r.account and upper(o.currency) = r.ccy
      and o.amount < 0 and -o.amount >= r.amount - 0.005
      -- spending only: "Покупка/продажа" answering a trade is no refund
      and o.expense_category is not null and not expense_not_spending(o.expense_category)
      and coalesce(o.authorized_on, o.tx_date::date) between r.day - 120 and r.day
      and trim(regexp_replace(lower(regexp_replace(o.description, '^\s*(payment in|оплата в)\s+', '', 'i')), '[^[:alnum:]]+', ' ', 'g')) = r.merch
    where r.merch <> ''
    order by r.id, o.tx_date desc
  ) m
  where b.id = m.id and not b.refund_manual;
  update bank_transactions b set refund_of = 'unmatched'
  from refund_rows r where b.id = r.id and r.says_refund and b.refund_of is null;

  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted)
  select p_user, r.day, r.day, r.account, r.external_source, r.external_id, 'Refund: ' || r.description,
         -r.amount, r.ccy, -r.amount * usd_per_unit_on(r.ccy, r.day), c.cat, true
  from refund_rows r
  join bank_transactions b on b.id = r.id and b.refund_of is not null
  cross join lateral (
    select coalesce(
      (select o.expense_category from bank_transactions o where b.refund_of <> 'unmatched'
         and o.user_id = p_user and o.external_source || '|' || o.external_id = b.refund_of),
      (select o.expense_category from bank_transactions o where o.user_id = p_user and o.amount < 0
         and trim(regexp_replace(lower(regexp_replace(o.description, '^\s*(payment in|оплата в)\s+', '', 'i')), '[^[:alnum:]]+', ' ', 'g')) = r.merch
         and o.expense_category is not null order by o.tx_date desc limit 1),
      'Other') as cat
  ) c
  where not expense_not_spending(c.cat);

  perform refresh_income(p_user);$blk$;
begin
  if position('refunds (migration ...155)' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: refresh_income call not found'; end if;
  execute replace(d, a, b);
end $mig$;

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_income(uuid)'::regprocedure);
  a text := E'  where b.user_id = p_user and b.amount > 0 and not b.income_manual and not b.synthetic\n';
  b text := E'  where b.user_id = p_user and b.amount > 0 and not b.income_manual and not b.synthetic and b.refund_of is null\n';
begin
  if position(b in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_income: the rows in not found'; end if;
  d := replace(d, a, b);
  -- the interest kept only as trades: a savings account's or a deposit's (not
  -- one paid out to a card or a wallet -- that row in is the income already),
  -- and the Revolut money market funds' daily return less the fund's fee
  a := E'  where b.user_id = p_user and b.amount > 0 and b.income_category is not null;';
  b := $blk$  where b.user_id = p_user and b.amount > 0 and b.income_category is not null
  union all
  select p_user, t.trade_date, coalesce(t.account, ''), coalesce(t.external_source, 'trades'), coalesce(t.external_id, t.id::text),
         coalesce(t.note, t.ticker), t.quantity * t.price, upper(t.currency),
         t.quantity * t.price * usd_per_unit_on(t.currency, t.trade_date), 'Interest'
  from trades t
  where t.user_id = p_user and t.ticker ~* '^(SAVINGS|DEPOSIT):' and t.side = 'buy' and not coalesce(t.estimated, false)
    and coalesce(t.note, '') ~* 'interest|процент|капитализац|пролонгац'
    and not exists (select 1 from internal_transfers x where x.user_id = p_user and x.matched_by <> 'rejected'
                    and x.in_source = t.external_source and x.in_id = t.external_id)
    and not exists (select 1 from bank_transactions o where o.user_id = p_user and o.amount > 0
                    and abs(o.amount - t.quantity * t.price) < 0.01 and upper(o.currency) = upper(t.currency)
                    and o.tx_date::date between t.trade_date - 3 and t.trade_date + 3
                    and o.description ~* 'interest|процент|капитализац')
  union all
  select p_user, t.trade_date, '', 'revolut_fund_csv', 'return:' || t.ticker || ':' || t.trade_date,
         'Money market fund return less fee: ' || t.ticker, sum(t.quantity), upper(t.currency),
         sum(t.quantity) * usd_per_unit_on(t.currency, t.trade_date), 'Interest'
  from trades t
  where t.user_id = p_user and t.external_source = 'revolut_fund_csv' and t.side = 'dividend' and not coalesce(t.estimated, false)
  group by t.trade_date, t.ticker, t.currency
  having sum(t.quantity) > 0;$blk$;
  if position(a in d) = 0 then raise exception 'refresh_income: the insert into income not found'; end if;
  execute replace(d, a, b);
end $mig$;

-- coupons and the banks' interest: by the rows' words (a broker's cash, a
-- card's interest on the balance); before the catch-all Other. Dividends are
-- no income (03.11.2026: "это самообман" -- the share is worth that much less):
-- the catch-all leaves them out too
insert into public.income_rules (user_id, priority, category, description_re, source_re, exclude_re)
select u.user_id, r.priority, r.category, r.description_re, '^(?!estimate_)', r.exclude_re
from (select distinct user_id from public.income_rules) u
cross join (values
  (101, 'Coupons', 'купон|coupon|Выплата дохода по облигациям|Периодическая выплата по ЦФА', 'возврат|refund|погашени|амортизац'),
  (102, 'Interest', 'interest|процент|капитализац', 'без процент|беспроцент|interest[- ]free|возврат|refund')
) r(priority, category, description_re, exclude_re)
where not exists (select 1 from public.income_rules x where x.user_id = u.user_id and x.category = r.category);
update public.income_rules set exclude_re = exclude_re || '|дивиденд|dividend'
where category = 'Other' and exclude_re is not null and exclude_re !~ 'дивиденд';

create or replace function public.transfer_pairs(p_from date, p_to date)
returns table (pair_id bigint, kind text, category text,
               out_source text, out_id text, out_day date, out_account text, out_description text, out_amount numeric, out_currency text, out_usd numeric,
               in_source text, in_id text, in_day date, in_account text, in_description text, in_amount numeric, in_currency text, in_usd numeric)
language sql stable security invoker set search_path = public as $$
  with legs as (
    select b.external_source as src, b.external_id as id, coalesce(b.authorized_on, b.tx_date::date) as day, b.account,
           b.description, b.amount, upper(b.currency) as ccy, b.expense_category as cat
    from bank_transactions b
    where b.user_id = auth.uid() and exists (select 1 from internal_transfers x where x.user_id = auth.uid()
      and ((x.out_source = b.external_source and x.out_id = b.external_id) or (x.in_source = b.external_source and x.in_id = b.external_id)))
    union all
    select t.external_source, t.external_id, t.trade_date, coalesce(t.account, ''), coalesce(t.note, t.ticker),
           case when t.side = 'buy' then t.quantity * t.price else -t.quantity * t.price end, upper(t.currency), null
    from trades t
    where t.user_id = auth.uid() and t.external_id is not null and exists (select 1 from internal_transfers x where x.user_id = auth.uid()
      and ((x.out_source = t.external_source and x.out_id = t.external_id) or (x.in_source = t.external_source and x.in_id = t.external_id)))
  )
  select x.id, x.kind, coalesce(o.cat, 'Own accounts'),
         o.src, o.id, o.day, o.account, o.description, o.amount, o.ccy, o.amount * usd_per_unit_on(o.ccy, o.day),
         i.src, i.id, i.day, i.account, i.description, i.amount, i.ccy, i.amount * usd_per_unit_on(i.ccy, i.day)
  from internal_transfers x
  join legs o on o.src = x.out_source and o.id = x.out_id
  join legs i on i.src = x.in_source and i.id = x.in_id
  where x.user_id = auth.uid() and x.matched_by <> 'rejected'
    and least(o.day, i.day) <= p_to and greatest(o.day, i.day) >= p_from
$$;

create or replace function public.unpaired_in(p_from date, p_to date)
returns table (day date, account text, description text, amount numeric, currency text, usd numeric, bank_category text)
language sql stable security invoker set search_path = public as $$
  select coalesce(b.authorized_on, b.tx_date::date), b.account, b.description, b.amount, upper(b.currency),
         b.amount * usd_per_unit_on(b.currency, coalesce(b.authorized_on, b.tx_date::date)), b.category
  from bank_transactions b
  where b.user_id = auth.uid() and b.amount > 0 and not b.synthetic and b.income_category is null and b.refund_of is null
    and coalesce(b.authorized_on, b.tx_date::date) between p_from and p_to
    and not exists (select 1 from internal_transfers x where x.user_id = auth.uid() and x.matched_by <> 'rejected'
                    and x.in_source = b.external_source and x.in_id = b.external_id)
$$;
grant execute on function public.transfer_pairs(date, date), public.unpaired_in(date, date) to authenticated;

select request_capital_refresh(u.user_id) from (select distinct user_id from public.bank_transactions) u;
