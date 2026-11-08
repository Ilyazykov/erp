-- suggest_products (migration ...179) offered a product by how alike the two
-- names look as whole strings only, so "Dardanel canned tuna" missed
-- "Dardanel tuna salad with Mexican beans 160 g" (the same tin, a longer name).
-- A product's English name now also scores by the words the two names share
-- (the share of the receipt's words that the product's name has), and the
-- higher of the two scores counts. Words of three letters or fewer, and a few
-- filler words, don't count. Still only offers: nothing is linked by itself.

create or replace function public.suggest_products(p_name text, p_name_en text, p_chain text default null)
returns table (product_id bigint, name_en text, score real, via text)
language sql stable as $$
  with q as (
    select array(
      select w from unnest(regexp_split_to_array(lower(coalesce(p_name_en, p_name)), '[^[:alnum:]]+')) w
      where length(w) >= 3 and w not in ('with', 'the', 'and', 'for', 'from', 'pcs')
    ) as ws
  ),
  names as (
    select p.id, p.name_en,
      greatest(
        extensions.similarity(p.name_en, coalesce(p_name_en, p_name)),
        (select count(*) from unnest(q.ws) w where w = any(regexp_split_to_array(lower(p.name_en), '[^[:alnum:]]+')))::real
          / nullif(cardinality(q.ws), 0)
      ) as score
    from public.products p, q
    where p.user_id = auth.uid() and p.merged_into is null
  )
  select a.product_id, p.name_en, extensions.similarity(a.name_norm, public.receipt_norm(p_name)) as score, 'alias'::text as via
  from public.product_aliases a join public.products p on p.id = a.product_id
  where a.user_id = auth.uid() and p.merged_into is null
    and (a.chain = '' or a.chain = coalesce(p_chain, ''))
    and extensions.similarity(a.name_norm, public.receipt_norm(p_name)) > 0.3
  union all
  select n.id, n.name_en, n.score, 'name_en'::text
  from names n
  where n.score > 0.3
  order by score desc
  limit 8
$$;
