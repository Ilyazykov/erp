-- A bank row with no place takes the place its merchant had before: the name
-- of the merchant ("ltd tamarind", "berezka", "wolt") is the text before the
-- first comma or ">" once the bank's "POS -" / "POS wallet -" prefix is off.
-- Only when every earlier row of that merchant has the same place -- a chain
-- with several branches (SPAR) stays unset and is chosen by hand.

create or replace function public.merchant_key(p text) returns text
language sql immutable as $$
  select nullif(trim(split_part(split_part(
    regexp_replace(lower(coalesce(p, '')), '^(pos wallet - |pos - |pos )', ''), ',', 1), '>', 1)), '')
$$;

create or replace function public.bank_place_from_merchant() returns trigger
language plpgsql as $$
declare
  v_key text;
  v_count integer;
  v_place bigint;
begin
  if new.place_id is not null then return new; end if;
  v_key := public.merchant_key(new.description);
  if v_key is null then return new; end if;
  select count(distinct b.place_id), max(b.place_id) into v_count, v_place
  from public.bank_transactions b
  where b.user_id = new.user_id
    and b.place_id is not null
    and public.merchant_key(b.description) = v_key;
  if v_count = 1 then new.place_id := v_place; end if;
  return new;
end $$;

drop trigger if exists bank_place_from_merchant on public.bank_transactions;
create trigger bank_place_from_merchant before insert on public.bank_transactions
  for each row execute function public.bank_place_from_merchant();
