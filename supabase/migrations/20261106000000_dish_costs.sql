-- Dish costs, step 2: the cost of each dish on the menu.
--   * the menu price of a dish (with GST, as printed on the menu);
--   * how much of each ingredient (or sauce) goes on one plate, with its
--     unit (g, kg, ml, l, each);
--   * for a sauce or prep made in the kitchen, what one batch makes, so its
--     own cost per kg / litre / each can be worked out;
--   * a price typed by hand (per kg / litre / each) for an ingredient or
--     sauce that has no invoice price yet. An invoice link always wins.
-- The app adds it up. Administrator and Kitchen Manager only.
-- Additive only: three new tables and three new functions. Nothing existing changes.

create table if not exists public.dish_costing (
  recipe_id uuid primary key references public.recipes(id),
  location text not null,
  sell_price numeric(10,2) check (sell_price is null or (sell_price > 0 and sell_price < 10000)),
  yield_qty numeric(12,3) check (yield_qty is null or (yield_qty > 0 and yield_qty < 100000)),
  yield_unit text check (yield_unit is null or yield_unit in ('g', 'kg', 'ml', 'l', 'each')),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.dish_portions (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  recipe_id uuid not null references public.recipes(id),
  ref_kind text not null check (ref_kind in ('ingredient', 'recipe')),
  ref_id uuid not null,
  qty numeric(12,3) not null check (qty > 0 and qty < 100000),
  unit text not null check (unit in ('g', 'kg', 'ml', 'l', 'each')),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  unique (recipe_id, ref_kind, ref_id)
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
               'sell_price', dc.sell_price, 'yield_qty', dc.yield_qty, 'yield_unit', dc.yield_unit,
               'lines', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'kind', case when l.ingredient_id is not null then 'ingredient' else 'recipe' end,
                          'ref_id', coalesce(l.ingredient_id, l.sub_recipe_id),
                          'name', coalesce(g.name, s.name), 'quantity', l.quantity,
                          'qty', p.qty, 'unit', p.unit)
                        order by l.position, l.id)
                   from public.recipe_lines l
                   left join public.recipe_ingredients g on g.id = l.ingredient_id
                   left join public.recipes s on s.id = l.sub_recipe_id
                   left join public.dish_portions p on p.recipe_id = r.id
                         and p.ref_kind = case when l.ingredient_id is not null then 'ingredient' else 'recipe' end
                         and p.ref_id = coalesce(l.ingredient_id, l.sub_recipe_id)
                  where l.recipe_id = r.id and l.active and coalesce(l.ingredient_id, l.sub_recipe_id) is not null), '[]'::jsonb),
               'manual', (select jsonb_build_object('price', m.price, 'unit', m.unit, 'note', m.note)
                            from public.cost_manual_prices m where m.ref_kind = 'recipe' and m.ref_id = r.id))
             order by r.category, lower(r.name))
        from public.recipes r
        left join public.dish_costing dc on dc.recipe_id = r.id
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
       where g.location = v_location), '[]'::jsonb));
end $function$;

-- Save a dish: p_data may hold sell_price, yield_qty + yield_unit, and
-- portions: [{kind, ref_id, qty, unit}] (qty empty = not counted).
-- Only the keys sent are changed.
create or replace function public.manager_dish_cost_save(p_manager_id uuid, p_location text, p_recipe_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_old jsonb;
  v_p jsonb;
  v_kind text;
  v_ref uuid;
  v_qty numeric;
begin
  if not exists (select 1 from public.recipes where id = p_recipe_id and location = v_location and active) then
    raise exception 'RECIPE_NOT_FOUND';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  select jsonb_build_object('costing', (select to_jsonb(d) from public.dish_costing d where d.recipe_id = p_recipe_id),
                            'portions', (select jsonb_agg(jsonb_build_object('kind', ref_kind, 'ref_id', ref_id, 'qty', qty, 'unit', unit))
                                           from public.dish_portions where recipe_id = p_recipe_id))
    into v_old;
  insert into public.dish_costing (recipe_id, location, updated_by) values (p_recipe_id, v_location, p_manager_id)
  on conflict (recipe_id) do nothing;
  if p_data ? 'sell_price' then
    update public.dish_costing set sell_price = nullif(p_data->>'sell_price', '')::numeric, updated_by = p_manager_id, updated_at = now()
     where recipe_id = p_recipe_id;
  end if;
  if p_data ? 'yield_qty' then
    update public.dish_costing set yield_qty = nullif(p_data->>'yield_qty', '')::numeric,
           yield_unit = case when nullif(p_data->>'yield_qty', '') is null then null else p_data->>'yield_unit' end,
           updated_by = p_manager_id, updated_at = now()
     where recipe_id = p_recipe_id;
    if exists (select 1 from public.dish_costing where recipe_id = p_recipe_id and yield_qty is not null and yield_unit is null) then
      raise exception 'INVALID_INPUT';
    end if;
  end if;
  if jsonb_typeof(p_data->'portions') = 'array' then
    if jsonb_array_length(p_data->'portions') > 200 then raise exception 'INVALID_INPUT'; end if;
    for v_p in select * from jsonb_array_elements(p_data->'portions') loop
      v_kind := v_p->>'kind';
      v_ref := (v_p->>'ref_id')::uuid;
      v_qty := nullif(v_p->>'qty', '')::numeric;
      if v_kind not in ('ingredient', 'recipe') then raise exception 'INVALID_INPUT'; end if;
      if not exists (select 1 from public.recipe_lines l where l.recipe_id = p_recipe_id and l.active
                        and ((v_kind = 'ingredient' and l.ingredient_id = v_ref) or (v_kind = 'recipe' and l.sub_recipe_id = v_ref))) then
        raise exception 'LINE_NOT_FOUND';
      end if;
      if v_qty is null or v_qty = 0 then
        delete from public.dish_portions where recipe_id = p_recipe_id and ref_kind = v_kind and ref_id = v_ref;
      else
        insert into public.dish_portions (location, recipe_id, ref_kind, ref_id, qty, unit, updated_by)
        values (v_location, p_recipe_id, v_kind, v_ref, v_qty, v_p->>'unit', p_manager_id)
        on conflict (recipe_id, ref_kind, ref_id) do update
          set qty = excluded.qty, unit = excluded.unit, updated_by = excluded.updated_by, updated_at = now();
      end if;
    end loop;
  end if;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('dish_cost', p_recipe_id::text, p_manager_id, v_old, p_data);
  return jsonb_build_object('recipe_id', p_recipe_id);
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
