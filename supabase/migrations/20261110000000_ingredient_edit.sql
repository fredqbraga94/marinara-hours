-- Ingredient prices: the price can be typed in (for a supplier that sends no
-- PDF, e.g. Niko) and an ingredient can be renamed. The typed price is the one
-- the dish costs already use when an ingredient has no invoice link
-- (cost_manual_prices, from 20261106000000_dish_costs.sql); the list now shows
-- it. A new name shows everywhere at once: recipes and dish costs point to the
-- ingredient, not to its name. Administrator and Kitchen Manager only.
-- Changes one function (manager_ingredient_costs: adds 'manual', the rest is
-- the same) and adds one. No table changes.

create or replace function public.manager_ingredient_costs(p_manager_id uuid, p_location text)
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
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name,
               'used_in', (select count(distinct rl.recipe_id) from public.recipe_lines rl
                             join public.recipes r on r.id = rl.recipe_id and r.active
                            where rl.ingredient_id = g.id and rl.active and lower(r.name) <> lower(g.name)),
               'made_here', (select jsonb_build_object('recipe_id', r.id, 'empty_lines',
                                      not exists (select 1 from public.recipe_lines rl where rl.recipe_id = r.id and rl.active
                                                     and coalesce(rl.ingredient_id, '00000000-0000-0000-0000-000000000000') <> g.id),
                                      'used_in', (select count(distinct rl.recipe_id) from public.recipe_lines rl
                                                    join public.recipes d on d.id = rl.recipe_id and d.active
                                                   where rl.sub_recipe_id = r.id and rl.active))
                               from public.recipes r
                              where r.location = g.location and r.active and lower(r.name) = lower(g.name)
                                and r.category in ('Sauce', 'Dressing', 'Prep')
                              order by r.created_at limit 1),
               'link', case when c.id is null then null else jsonb_build_object(
                 'supplier', c.supplier, 'product_key', c.product_key, 'label', c.product_label,
                 'pack_count', c.pack_count, 'pack_size', c.pack_size, 'pack_unit', c.pack_unit,
                 'base_unit', case c.pack_unit when 'g' then 'kg' when 'ml' then 'l' else c.pack_unit end,
                 'latest_price', p.unit_price, 'price_date', p.invoice_date,
                 'cost_per_unit', case when p.unit_price is null then null else round(
                   p.unit_price / (c.pack_count * c.pack_size / case when c.pack_unit in ('g', 'ml') then 1000 else 1 end), 4) end)
               end,
               'manual', (select jsonb_build_object('price', m.price, 'unit', m.unit, 'note', m.note, 'updated_at', m.updated_at)
                            from public.cost_manual_prices m where m.ref_kind = 'ingredient' and m.ref_id = g.id))
             order by lower(g.name))
        from public.recipe_ingredients g
        left join public.recipe_ingredient_costs c on c.ingredient_id = g.id and c.active
        left join public.mh_invoice_products(v_location) p on p.supplier = c.supplier and p.product_key = c.product_key
       where g.location = v_location), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'supplier', p.supplier, 'product_key', p.product_key, 'code', p.code,
               'description', p.description, 'unit', p.unit, 'price', p.unit_price, 'date', p.invoice_date)
             order by p.supplier, p.description)
        from public.mh_invoice_products(v_location) p), '[]'::jsonb));
end $function$;

-- Rename an ingredient. Refused when another ingredient already has the name,
-- when a kitchen-made recipe (Sauce, Dressing, Prep) has it, or when the
-- ingredient is itself made in the kitchen (rename its recipe instead).
create or replace function public.manager_ingredient_rename(p_manager_id uuid, p_location text, p_ingredient_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_name text := left(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), 80);
  v_old public.recipe_ingredients%rowtype;
begin
  select * into v_old from public.recipe_ingredients where id = p_ingredient_id and location = v_location;
  if not found then raise exception 'INGREDIENT_NOT_FOUND'; end if;
  if v_name = '' then raise exception 'INVALID_INPUT'; end if;
  if v_name = v_old.name then return jsonb_build_object('id', v_old.id, 'name', v_old.name); end if;
  if exists (select 1 from public.recipe_ingredients g where g.location = v_location and g.id <> v_old.id and lower(g.name) = lower(v_name)) then
    raise exception 'INGREDIENT_EXISTS';
  end if;
  if exists (select 1 from public.recipes r where r.location = v_location and r.active and r.category in ('Sauce', 'Dressing', 'Prep')
               and lower(r.name) in (lower(v_old.name), lower(v_name))) then
    raise exception 'NAME_IS_A_DISH';
  end if;
  update public.recipe_ingredients set name = v_name where id = v_old.id;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('ingredient_rename', v_old.id::text, p_manager_id, jsonb_build_object('name', v_old.name), jsonb_build_object('name', v_name));
  return jsonb_build_object('id', v_old.id, 'name', v_name);
exception
  when check_violation then raise exception 'INVALID_INPUT';
  when unique_violation then raise exception 'INGREDIENT_EXISTS';
end $function$;

revoke all on function public.manager_ingredient_costs(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_ingredient_rename(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.manager_ingredient_costs(uuid, text) to service_role;
grant execute on function public.manager_ingredient_rename(uuid, text, uuid, text) to service_role;
