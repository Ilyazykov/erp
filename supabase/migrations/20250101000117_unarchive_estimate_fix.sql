-- unarchive_estimate (...114): one CASE over NEW's fields broke on the tables
-- without them ('record "new" has no field "wallet_id"' on trades) -- a
-- branch per table instead, each touching only its own table's fields.
create or replace function public.unarchive_estimate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'trades' then
    delete from estimate_archive where tbl = 'trades'
      and key = coalesce(new.external_source, '') || '|' || coalesce(new.external_id, new.id::text);
  elsif tg_table_name = 'bank_transactions' then
    delete from estimate_archive where tbl = 'bank_transactions'
      and key = new.external_source || '|' || coalesce(new.external_id, new.id::text);
  else
    delete from estimate_archive where tbl = 'wallet_transactions' and key = new.wallet_id::text || '|' || new.tx_hash;
  end if;
  return new;
end $$;
