-- The capital history is marked dirty from a changed row's day (migration ...231). A bank row
-- counted as changed when only its expense / income bookkeeping changed -- refresh_expenses
-- re-categorising old operations (it runs in every capital refresh) or a category set by hand
-- -- though no capital function reads those columns (checked 24.11.2026: refresh_capital_*,
-- capital_*, refresh_investment_daily, investment_by_asset, match_internal_transfers,
-- match_card_crypto_purchases). The rebuild then went back to 2017-2018 after every request,
-- about one month a minute, and today's prices waited behind it for an hour or more.
create or replace function public.capital_dirty_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  skip text[] := array['created_at', 'updated_at', 'last_synced_at', 'last_sync_error',
    -- the expense / income bookkeeping of a bank row: not read by the capital history
    'expense_category', 'expense_manual', 'expense_spread_months', 'expense_spread_from', 'expense_note',
    'income_category', 'income_manual', 'refund_of', 'refund_manual', 'place_id', 'delivery_place_id'];
  who text := case when TG_ARGV[1] = 'user' then '(j->>''user_id'')::uuid' else 'null::uuid' end;
  changed text;
begin
  changed := case TG_OP
    when 'INSERT' then 'select to_jsonb(r) - $1 as j from new_rows r'
    when 'DELETE' then 'select to_jsonb(r) - $1 as j from old_rows r'
    else '(select to_jsonb(r) - $1 as j from new_rows r except select to_jsonb(r) - $1 from old_rows r)
          union all
          (select to_jsonb(r) - $1 from old_rows r except select to_jsonb(r) - $1 from new_rows r)'
  end;
  execute format('select public.capital_mark_dirty(u, d) from (select %s as u, min(%s) as d from (%s) c group by 1) x',
    who, TG_ARGV[0], changed) using skip;
  return null;
end $$;
