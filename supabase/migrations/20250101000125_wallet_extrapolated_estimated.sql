-- wallet_transactions.estimated (...110) now also marks a day worked out
-- rather than seen: Telegram's Earn rewards "Rewarded / Bonus
-- (extrapolated)" (import-telegram-wallet) -- estimated for good, no
-- statement will ever replace them. The short-lived projections are the
-- estimated rows whose tx_hash starts 'estimated:' (sync-estimates,
-- sync-crypto-com-estimates): only those are rebuilt nightly, and only
-- those go to / come back from estimate_archive (...114) -- a re-upload
-- replacing extrapolated days archives nothing.
drop trigger if exists wallet_archive_estimate on public.wallet_transactions;
create trigger wallet_archive_estimate after delete on public.wallet_transactions
  for each row when (old.estimated and old.tx_hash like 'estimated:%') execute function public.archive_estimate();
drop trigger if exists wallet_unarchive_estimate on public.wallet_transactions;
create trigger wallet_unarchive_estimate after insert on public.wallet_transactions
  for each row when (new.estimated and new.tx_hash like 'estimated:%') execute function public.unarchive_estimate();

update public.wallet_transactions set estimated = true
where chain = 'telegram' and not estimated and status like '%(extrapolated)%';
