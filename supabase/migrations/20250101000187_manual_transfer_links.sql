-- A transfer the user links by hand (matched_by 'manual') may take one out row
-- to several in rows: one payment out, given back in parts (asked 08.11.2026:
-- 06.11 320 GEL out to "Private transfer within TBC", back as 1 000 and 9 050 RUB
-- from the same person). The "each out row once" rule stays for the rows the
-- matcher pairs itself (matched_by 'auto'); 'returned' (...130) keeps its own
-- rule as it is.

drop index if exists public.internal_transfers_user_out_once;
create unique index internal_transfers_user_out_once on public.internal_transfers (user_id, out_source, out_id)
  where kind <> 'returned' and matched_by <> 'manual';

-- the two 06.11 links of the TBC payment were written as 'returned' before this
-- index allowed them as 'transfer' (the user's choice: the first option)
update public.internal_transfers set kind = 'transfer'
where matched_by = 'manual' and kind = 'returned'
  and out_source = 'tbc_bank_csv:19475881'
  and out_id = '19475881:2026-11-06::Private transfer within TBC:-320'
  and in_source = 'sber_csv:40817810942004893373'
  and in_id in (
    '40817810942004893373:2026-11-06:14:48:Перевод по СБП Оксана Дмитриевна Ж.:1000',
    '40817810942004893373:2026-11-06:14:51:Перевод по СБП Оксана Дмитриевна Ж.:9050');
