-- Today's prices every hour, not once a day at 06:00 UTC (asked 05.11.2026):
-- the portfolio table showed the morning's prices all day. A run takes some
-- 40 s against free sources only (Yahoo, MOEX, the CBR -- no keys, no
-- quotas); 24 calls a day. The job keeps its name.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'update-market-prices-daily'),
  schedule := '0 * * * *'
);
