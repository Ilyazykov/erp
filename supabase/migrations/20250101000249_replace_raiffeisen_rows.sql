-- A Raiffeisen upload replaces its rows in one transaction: the delete and the
-- insert used to be two requests, and a timeout between them left the account
-- without the rows of the file's currencies. Now any error keeps the old rows.
-- p_from / p_to: a statement's period (only its days are replaced); none: the
-- whole history of the file's currencies.
create or replace function public.replace_raiffeisen_rows(p_rows jsonb, p_from date default null, p_to date default null)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No rows to import';
  end if;
  if (p_from is null) <> (p_to is null) or p_from > p_to then
    raise exception 'from / to: not a period';
  end if;

  delete from public.bank_transactions b
  where b.user_id = v_user
    and b.external_source = 'raiffeisen_csv'
    and b.currency in (select distinct r->>'currency' from jsonb_array_elements(p_rows) r)
    and (p_from is null or (b.tx_date >= (p_from::text || 'T00:00:00Z')::timestamptz
                        and b.tx_date <= (p_to::text || 'T23:59:59Z')::timestamptz));

  insert into public.bank_transactions
    (user_id, account, tx_date, description, counterparty, amount, currency, category, balance_after, external_source, external_id)
  select v_user, 'Raiffeisen', r.tx_date, r.description, null, r.amount, r.currency, r.category, r.balance_after, 'raiffeisen_csv', r.external_id
  from jsonb_to_recordset(p_rows) as r(tx_date timestamptz, description text, amount numeric, currency text,
                                       category text, balance_after numeric, external_id text)
  on conflict (user_id, external_source, external_id) do update set
    account = excluded.account, tx_date = excluded.tx_date, description = excluded.description,
    counterparty = excluded.counterparty, amount = excluded.amount, currency = excluded.currency,
    category = excluded.category, balance_after = excluded.balance_after;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.replace_raiffeisen_rows(jsonb, date, date) from public, anon;
grant execute on function public.replace_raiffeisen_rows(jsonb, date, date) to authenticated;
