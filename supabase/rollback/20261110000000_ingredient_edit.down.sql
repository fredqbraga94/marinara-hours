-- Rollback of 20261110000000_ingredient_edit.sql: manager_ingredient_costs
-- goes back to its first version (no 'manual'); renaming goes away. Names
-- already changed stay as they are.
drop function if exists public.manager_ingredient_rename(uuid, text, uuid, text);

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
               end)
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

revoke all on function public.manager_ingredient_costs(uuid, text) from public, anon, authenticated;
grant execute on function public.manager_ingredient_costs(uuid, text) to service_role;
