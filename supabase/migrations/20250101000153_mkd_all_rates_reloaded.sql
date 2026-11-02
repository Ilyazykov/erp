-- The denar's and the lek's history came from Yahoo and ran off the official
-- rates (EUR/MKD 61.09 against the National Bank's 61.55, EUR/ALL 94.1 against
-- 96.7, October 2025): the card payments made in them looked converted better
-- than the market, no exchange fee to show. update-capital-history now takes
-- them from the National Bank of North Macedonia and fawazahmed0's currency-api;
-- the Yahoo rows go, so its next run loads the whole history again.

delete from public.fx_history where currency in ('MKD', 'ALL');
