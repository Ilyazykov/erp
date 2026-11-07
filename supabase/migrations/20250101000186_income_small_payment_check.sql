-- A small payment from the sender of the flat rent, made on the same day and from
-- the same account as a rent payment from that sender, is part of that rent: the
-- first one is a check that the account works, the big one follows (asked
-- 08.11.2026; 03.11.2026 10:00 500 RUB and 10:05 6 500 RUB). The rule 9 keeps its
-- 1000 RUB threshold for payments on their own. Patched in place as ...141 and
-- ...155 do.
--
-- The one-off: 06.11.2026 16:40, 100 RUB from the same sender, with no rent
-- payment from them that day -- the user put it in the rent by hand (income_manual).

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_income(uuid)'::regprocedure);
  a text := E'  update bank_transactions b set income_category = null\n';
  b text := E'  -- a small payment from the rent\'s sender, the same day and account as a rent payment\n'
    || E'  -- from them: the check that the account works (08.11.2026)\n'
    || E'  update income_rows e set cat = \'Flat rent\'\n'
    || E'  where e.cat is null and e.amount < 1000\n'
    || E'    and e.description ~* \'svetlana viktorovna|светлана викторовна|9101254519|910 125-45-19\'\n'
    || E'    and exists (select 1 from income_rows f\n'
    || E'      join bank_transactions bf on bf.id = f.id\n'
    || E'      join bank_transactions be on be.id = e.id\n'
    || E'      where f.cat = \'Flat rent\' and f.account = e.account and f.description ~* \'svetlana viktorovna|светлана викторовна|9101254519|910 125-45-19\'\n'
    || E'        and bf.tx_date::date = be.tx_date::date);\n\n'
    || E'  update bank_transactions b set income_category = null\n';
begin
  if position(a in d) = 0 then raise exception 'refresh_income: the category reset step not found'; end if;
  execute replace(d, a, b);
end $mig$;

update bank_transactions
set income_category = 'Flat rent', income_manual = true
where user_id = 'd8905b70-2033-4755-9d1c-617a5d609e6f'
  and external_source = 'sber_csv:40817810942004893373'
  and external_id = '40817810942004893373:2026-11-06:16:40:Входящий перевод Светлана Викторовна П.:100';
