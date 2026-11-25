-- The capital refresh step ran into the 2-minute statement timeout: refresh_expenses alone
-- took over 120 s after a receipt upload (26.11.2026), every run failed and rolled back, the
-- next one began from the same place a minute later -- the expenses never rebuilt and the
-- database busy all the time. The step's own statement gets 10 minutes.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'capital-refresh-step'),
  command := $c$set statement_timeout = '10min'; select public.run_capital_refresh_step()$c$
);
