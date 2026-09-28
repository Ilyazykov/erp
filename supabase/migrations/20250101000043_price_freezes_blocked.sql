-- More frozen securities for capital history (price_freezes, 033): valued
-- at market until blocked, 0 from then. T-Bank moved them to its blocked-
-- assets agreement only in 2026 and the report doesn't date the move, so
-- without these they'd count at market until then.
--   RUSE (ITI Funds, LU1483649312): last traded on MOEX 25.02.2022, like
--     the FinEx funds;
--   VOW3, BMW, BAYN (German shares bought on SPB Exchange): blocked with
--     the EU sanctions on the NSD, 03.06.2022.

insert into public.price_freezes (ticker, frozen_from, note) values
  ('RUSE', date '2022-02-28', 'ITI Funds RUSE: last MOEX trade 25.02.2022, blocked since'),
  ('VOW3', date '2022-06-03', 'Blocked with the EU sanctions on the NSD (03.06.2022)'),
  ('BMW', date '2022-06-03', 'Blocked with the EU sanctions on the NSD (03.06.2022)'),
  ('BAYN', date '2022-06-03', 'Blocked with the EU sanctions on the NSD (03.06.2022)')
on conflict (ticker) do update set frozen_from = excluded.frozen_from, note = excluded.note;
