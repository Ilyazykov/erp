-- Staking on a wallet of the user's own (TON: Gram to Tonstakers for tsTON,
-- 11.11.2026; sync-crypto-wallets stores its legs as 'staking_internal') is
-- an exchange of one coin for another inside the wallet: not money put in or
-- taken out of the portfolio (refresh_investment_daily counts on-chain
-- 'native' / 'token' / 'internal' only, so it doesn't), but by asset the coins
-- staked leave Gram and the ones minted come into tsTON -- as an exchange's
-- trade does. Left out, Gram looked to have lost what was staked (~$46) and
-- tsTON to have earned as much from nothing.
-- (On an exchange 'staking_internal' is a coin moving between its own
-- sub-accounts, the same coin both sides: still left out there.)
--
-- investment_by_asset patched in place: the rest stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.investment_by_asset(date,date,text)'::regprocedure);
  n text;
begin
  n := replace(d,
    $q$when not exchange and kind in ('native', 'token', 'internal', 'fee') then amt$q$,
    $q$when not exchange and kind in ('native', 'token', 'internal', 'fee', 'staking_internal') then amt$q$);
  if n = d then raise exception 'investment_by_asset: the on-chain kinds not where expected'; end if;
  execute n;
end $$;
