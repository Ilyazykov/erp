-- The estimate_archive trigger functions (...114, ...117) are triggers only:
-- not callable through the API by anyone (the security advisor's warning).
revoke all on function public.archive_estimate() from public, anon, authenticated;
revoke all on function public.unarchive_estimate() from public, anon, authenticated;
