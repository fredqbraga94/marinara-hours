-- Dish costs, step 2: the cost of each dish on the menu.
--   * the menu price of a dish (with GST, as printed on the menu);
--   * how much of each ingredient (or sauce) goes on one plate, with its
--     unit (g, kg, ml, l, each);
--   * for a sauce or prep made in the kitchen, what one batch makes, so its
--     own cost per kg / litre / each can be worked out;
--   * a price typed by hand (per kg / litre / each) for an ingredient or
--     sauce that has no invoice price yet. An invoice link always wins;
--   * a dish can have more than one size (e.g. Entrée / Main, ½ doz / 1 doz),
--     each with its own menu price and amounts;
--   * one line of a dish can use a product of its own from the invoices
--     (e.g. Prawns → HTC prawn cutlet 13/15, 7 each), with what one invoice
--     line buys (e.g. 1 × 22 each). The products are those of the saved
--     invoices and of the imported supplier history (e.g. a year of Moco).
-- The app adds it up. Administrator and Kitchen Manager only.
-- Additive only: three new tables and three new functions. Nothing existing changes.

create table if not exists public.dish_costing (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id),
  location text not null,
  size text not null default '' check (length(size) <= 30),
  position int not null default 0,
  sell_price numeric(10,2) check (sell_price is null or (sell_price > 0 and sell_price < 10000)),
  yield_qty numeric(12,3) check (yield_qty is null or (yield_qty > 0 and yield_qty < 100000)),
  yield_unit text check (yield_unit is null or yield_unit in ('g', 'kg', 'ml', 'l', 'each')),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  unique (recipe_id, size)
);

create table if not exists public.dish_portions (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  recipe_id uuid not null references public.recipes(id),
  size text not null default '',
  ref_kind text not null check (ref_kind in ('ingredient', 'recipe')),
  ref_id uuid not null,
  qty numeric(12,3) not null check (qty > 0 and qty < 100000),
  unit text not null check (unit in ('g', 'kg', 'ml', 'l', 'each')),
  supplier text check (supplier is null or length(supplier) <= 120),
  product_key text check (product_key is null or length(product_key) <= 300),
  product_label text check (product_label is null or length(product_label) <= 300),
  pack_count numeric(12,3) check (pack_count is null or (pack_count > 0 and pack_count < 100000)),
  pack_size numeric(12,3) check (pack_size is null or (pack_size > 0 and pack_size < 100000)),
  pack_unit text check (pack_unit is null or pack_unit in ('g', 'kg', 'ml', 'l', 'each')),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  unique (recipe_id, size, ref_kind, ref_id),
  check ((product_key is null) = (pack_unit is null))
);

create table if not exists public.cost_manual_prices (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  ref_kind text not null check (ref_kind in ('ingredient', 'recipe')),
  ref_id uuid not null,
  price numeric(12,4) not null check (price > 0 and price < 100000),
  unit text not null check (unit in ('kg', 'l', 'each')),
  note text check (note is null or length(note) <= 200),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  unique (ref_kind, ref_id)
);

alter table public.dish_costing enable row level security;
alter table public.dish_portions enable row level security;
alter table public.cost_manual_prices enable row level security;
revoke all on public.dish_costing, public.dish_portions, public.cost_manual_prices from anon, authenticated;

-- Products a dish line can use: the saved invoices, then the imported supplier
-- history (its last price; key 'history:<code>'), newest first.
create or replace function public.mh_cost_products(p_location text)
returns table (supplier text, product_key text, description text, unit text, price numeric, price_date date, source text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.supplier, p.product_key, p.description, p.unit, p.unit_price, p.invoice_date, 'invoice'
    from public.mh_invoice_products(p_location) p
   where p.unit_price > 0
  union all
  select * from (
    select distinct on (h.supplier, hp.code) h.supplier, 'history:' || hp.code,
           trim(coalesce(hp.brand || ' · ', '') || hp.description),
           case when hp.cartons > 0 and hp.last_carton_price is not null then hp.carton_label else hp.unit_label end,
           case when hp.cartons > 0 and hp.last_carton_price is not null then hp.last_carton_price else hp.last_unit_price end,
           hp.last_date, 'history'
      from public.supplier_history_products hp
      join public.supplier_history_imports h on h.id = hp.import_id
     where h.location = p_location and h.active
       and coalesce(case when hp.cartons > 0 and hp.last_carton_price is not null then hp.last_carton_price else hp.last_unit_price end, 0) > 0
     order by h.supplier, hp.code, hp.last_date desc nulls last, h.imported_at desc
  ) latest;
$function$;
revoke all on function public.mh_cost_products(text) from public, anon, authenticated;

-- Everything the Dish costs screen needs; the app does the sums.
create or replace function public.manager_dish_costs(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return jsonb_build_object(
    'location', v_location,
    'recipes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'name', r.name, 'category', r.category, 'makes', r.makes,
               'lines', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'kind', case when l.ingredient_id is not null then 'ingredient' else 'recipe' end,
                          'ref_id', coalesce(l.ingredient_id, l.sub_recipe_id),
                          'name', coalesce(g.name, s.name), 'quantity', l.quantity)
                        order by l.position, l.id)
                   from public.recipe_lines l
                   left join public.recipe_ingredients g on g.id = l.ingredient_id
                   left join public.recipes s on s.id = l.sub_recipe_id
                  where l.recipe_id = r.id and l.active and coalesce(l.ingredient_id, l.sub_recipe_id) is not null), '[]'::jsonb),
               'sizes', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'size', dc.size, 'sell_price', dc.sell_price, 'yield_qty', dc.yield_qty, 'yield_unit', dc.yield_unit,
                          'portions', coalesce((
                            select jsonb_agg(jsonb_build_object(
                                     'kind', p.ref_kind, 'ref_id', p.ref_id, 'qty', p.qty, 'unit', p.unit,
                                     'product', case when p.product_key is null then null else jsonb_build_object(
                                       'supplier', p.supplier, 'product_key', p.product_key, 'label', p.product_label,
                                       'pack_count', p.pack_count, 'pack_size', p.pack_size, 'pack_unit', p.pack_unit,
                                       'price', ip.price, 'date', ip.price_date) end))
                              from public.dish_portions p
                              left join public.mh_cost_products(v_location) ip on ip.supplier = p.supplier and ip.product_key = p.product_key
                             where p.recipe_id = r.id and p.size = dc.size), '[]'::jsonb))
                        order by dc.position, dc.size)
                   from public.dish_costing dc where dc.recipe_id = r.id), '[]'::jsonb),
               'manual', (select jsonb_build_object('price', m.price, 'unit', m.unit, 'note', m.note)
                            from public.cost_manual_prices m where m.ref_kind = 'recipe' and m.ref_id = r.id))
             order by r.category, lower(r.name))
        from public.recipes r
       where r.location = v_location and r.active), '[]'::jsonb),
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name,
               'invoice', case when c.id is null or p.unit_price is null then null else jsonb_build_object(
                 'supplier', c.supplier, 'label', c.product_label, 'date', p.invoice_date,
                 'unit', case c.pack_unit when 'g' then 'kg' when 'ml' then 'l' else c.pack_unit end,
                 'price', round(p.unit_price / (c.pack_count * c.pack_size / case when c.pack_unit in ('g', 'ml') then 1000 else 1 end), 4))
               end,
               'manual', (select jsonb_build_object('price', m.price, 'unit', m.unit, 'note', m.note)
                            from public.cost_manual_prices m where m.ref_kind = 'ingredient' and m.ref_id = g.id))
             order by lower(g.name))
        from public.recipe_ingredients g
        left join public.recipe_ingredient_costs c on c.ingredient_id = g.id and c.active
        left join public.mh_invoice_products(v_location) p on p.supplier = c.supplier and p.product_key = c.product_key
       where g.location = v_location), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'supplier', p.supplier, 'product_key', p.product_key, 'description', p.description,
               'unit', p.unit, 'price', p.price, 'date', p.price_date, 'source', p.source)
             order by p.source desc, p.supplier, p.description)
        from public.mh_cost_products(v_location) p), '[]'::jsonb));
end $function$;

-- Save one size of a dish. p_data: {size ('' = the first/only size),
-- sell_price?, yield_qty + yield_unit?, portions?: [{kind, ref_id, qty, unit,
-- product?: {supplier, product_key, label, pack_count, pack_size, pack_unit}}]
-- (qty empty = not counted), remove?: true (removes that size)}.
-- Only the keys sent are changed.
create or replace function public.manager_dish_cost_save(p_manager_id uuid, p_location text, p_recipe_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_size text;
  v_old jsonb;
  v_p jsonb;
  v_pr jsonb;
  v_kind text;
  v_ref uuid;
  v_qty numeric;
begin
  if not exists (select 1 from public.recipes where id = p_recipe_id and location = v_location and active) then
    raise exception 'RECIPE_NOT_FOUND';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  v_size := left(trim(coalesce(p_data->>'size', '')), 30);
  select jsonb_build_object('costing', (select to_jsonb(d) - 'id' from public.dish_costing d where d.recipe_id = p_recipe_id and d.size = v_size),
                            'portions', (select jsonb_agg(to_jsonb(p) - 'id' - 'location') from public.dish_portions p
                                          where p.recipe_id = p_recipe_id and p.size = v_size))
    into v_old;
  if coalesce((p_data->>'remove')::boolean, false) then
    delete from public.dish_portions where recipe_id = p_recipe_id and size = v_size;
    delete from public.dish_costing where recipe_id = p_recipe_id and size = v_size;
  else
    insert into public.dish_costing (recipe_id, location, size, position, updated_by)
    values (p_recipe_id, v_location, v_size,
            coalesce((select max(position) + 1 from public.dish_costing where recipe_id = p_recipe_id), 0), p_manager_id)
    on conflict (recipe_id, size) do nothing;
    if p_data ? 'sell_price' then
      update public.dish_costing set sell_price = nullif(p_data->>'sell_price', '')::numeric, updated_by = p_manager_id, updated_at = now()
       where recipe_id = p_recipe_id and size = v_size;
    end if;
    if p_data ? 'yield_qty' then
      update public.dish_costing set yield_qty = nullif(p_data->>'yield_qty', '')::numeric,
             yield_unit = case when nullif(p_data->>'yield_qty', '') is null then null else p_data->>'yield_unit' end,
             updated_by = p_manager_id, updated_at = now()
       where recipe_id = p_recipe_id and size = v_size;
      if exists (select 1 from public.dish_costing where recipe_id = p_recipe_id and size = v_size and yield_qty is not null and yield_unit is null) then
        raise exception 'INVALID_INPUT';
      end if;
    end if;
    if jsonb_typeof(p_data->'portions') = 'array' then
      if jsonb_array_length(p_data->'portions') > 200 then raise exception 'INVALID_INPUT'; end if;
      for v_p in select * from jsonb_array_elements(p_data->'portions') loop
        v_kind := v_p->>'kind';
        v_ref := (v_p->>'ref_id')::uuid;
        v_qty := nullif(v_p->>'qty', '')::numeric;
        v_pr := case when jsonb_typeof(v_p->'product') = 'object' then v_p->'product' end;
        if v_kind not in ('ingredient', 'recipe') then raise exception 'INVALID_INPUT'; end if;
        if not exists (select 1 from public.recipe_lines l where l.recipe_id = p_recipe_id and l.active
                          and ((v_kind = 'ingredient' and l.ingredient_id = v_ref) or (v_kind = 'recipe' and l.sub_recipe_id = v_ref))) then
          raise exception 'LINE_NOT_FOUND';
        end if;
        if v_pr is not null and not exists (select 1 from public.mh_cost_products(v_location) ip
                                              where ip.supplier = v_pr->>'supplier' and ip.product_key = v_pr->>'product_key') then
          raise exception 'PRODUCT_NOT_FOUND';
        end if;
        if v_qty is null or v_qty = 0 then
          delete from public.dish_portions where recipe_id = p_recipe_id and size = v_size and ref_kind = v_kind and ref_id = v_ref;
        else
          insert into public.dish_portions (location, recipe_id, size, ref_kind, ref_id, qty, unit,
                                            supplier, product_key, product_label, pack_count, pack_size, pack_unit, updated_by)
          values (v_location, p_recipe_id, v_size, v_kind, v_ref, v_qty, v_p->>'unit',
                  v_pr->>'supplier', v_pr->>'product_key', left(v_pr->>'label', 300),
                  (v_pr->>'pack_count')::numeric, (v_pr->>'pack_size')::numeric, v_pr->>'pack_unit', p_manager_id)
          on conflict (recipe_id, size, ref_kind, ref_id) do update
            set qty = excluded.qty, unit = excluded.unit, supplier = excluded.supplier, product_key = excluded.product_key,
                product_label = excluded.product_label, pack_count = excluded.pack_count, pack_size = excluded.pack_size,
                pack_unit = excluded.pack_unit, updated_by = excluded.updated_by, updated_at = now();
        end if;
      end loop;
    end if;
  end if;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('dish_cost', p_recipe_id::text, p_manager_id, v_old, p_data);
  return jsonb_build_object('recipe_id', p_recipe_id, 'size', v_size);
exception
  when check_violation or invalid_text_representation or not_null_violation or numeric_value_out_of_range then
    raise exception 'INVALID_INPUT';
end $function$;

-- A price typed by hand for an ingredient or a sauce/prep. p_price:
-- {price, unit (kg | l | each), note}; null removes it.
create or replace function public.manager_cost_price_save(p_manager_id uuid, p_location text, p_kind text, p_ref_id uuid, p_price jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_old public.cost_manual_prices%rowtype;
begin
  if p_kind = 'ingredient' then
    if not exists (select 1 from public.recipe_ingredients where id = p_ref_id and location = v_location) then raise exception 'INGREDIENT_NOT_FOUND'; end if;
  elsif p_kind = 'recipe' then
    if not exists (select 1 from public.recipes where id = p_ref_id and location = v_location) then raise exception 'RECIPE_NOT_FOUND'; end if;
  else
    raise exception 'INVALID_INPUT';
  end if;
  delete from public.cost_manual_prices where ref_kind = p_kind and ref_id = p_ref_id returning * into v_old;
  if p_price is not null and jsonb_typeof(p_price) = 'object' then
    insert into public.cost_manual_prices (location, ref_kind, ref_id, price, unit, note, updated_by)
    values (v_location, p_kind, p_ref_id, (p_price->>'price')::numeric, p_price->>'unit',
            nullif(left(trim(coalesce(p_price->>'note', '')), 200), ''), p_manager_id);
  end if;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('cost_price', p_kind || ':' || p_ref_id, p_manager_id,
          case when v_old.id is null then null else to_jsonb(v_old) - 'id' end, p_price);
  return jsonb_build_object('ref_id', p_ref_id, 'kind', p_kind, 'saved', p_price is not null);
exception
  when check_violation or invalid_text_representation or not_null_violation or numeric_value_out_of_range then
    raise exception 'INVALID_INPUT';
end $function$;

revoke all on function public.manager_dish_costs(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_dish_cost_save(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_cost_price_save(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.manager_dish_costs(uuid, text) to service_role;
grant execute on function public.manager_dish_cost_save(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.manager_cost_price_save(uuid, text, text, uuid, jsonb) to service_role;
