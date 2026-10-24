-- Wise's own API sync (...120) is dropped: Wise no longer lets personal
-- accounts sign the Strong Customer Authentication of the balance statement
-- ("we no longer support signing API requests to complete strong customer
-- authentication on personal Wise accounts" -- Wise -> API tokens -> Manage
-- public keys, 25.10.2026), so a personal token can't read statements. Wise
-- stays on Enable Banking (sync-openbanking, ...107): sync-openbanking no
-- longer stands aside for it. The token itself is still kept, just in case
-- Wise opens statements again (set_wise_api / wise_api_status stay; the page
-- saves the token only) -- nothing runs with it.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-wise-daily';
