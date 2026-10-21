-- Ingredient costs, step 1: link each recipe ingredient to the product it is
-- bought as (from the saved supplier invoices) and say what the invoice price
-- buys (e.g. 6 x 2 kg). The app then knows the real price per kg / litre /
-- each, and it follows the latest invoice. An ingredient that is made in the
-- kitchen (e.g. pizza dough) can instead become its own Prep recipe, to be
-- filled in later. Administrator and Kitchen Manager only.
-- Additive only: one new table and new functions. Nothing existing changes.

create table if not exists public.recipe_ingredient_costs (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  ingredient_id uuid not null references public.recipe_ingredients(id),
  supplier text not null check (length(trim(supplier)) between 1 and 80),
  product_key text not null check (length(product_key) between 1 and 300),
  product_label text not null check (length(product_label) between 1 and 300),
  pack_count numeric(10,3) not null check (pack_count > 0 and pack_count <= 10000),
  pack_size numeric(12,3) not null check (pack_size > 0 and pack_size <= 100000),
  pack_unit text not null check (pack_unit in ('kg', 'g', 'l', 'ml', 'each')),
  active boolean not null default true,       -- replaced links are kept, switched off
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists recipe_ingredient_costs_one_idx
  on public.recipe_ingredient_costs (ingredient_id) where active;
create index if not exists recipe_ingredient_costs_product_idx
  on public.recipe_ingredient_costs (location, supplier, product_key) where active;

alter table public.recipe_ingredient_costs enable row level security;
revoke all on public.recipe_ingredient_costs from anon, authenticated;

-- Latest invoice price for each product (same supplier + code, or the same
-- description when the supplier prints no code). Fees are left out.
create or replace function public.mh_invoice_products(p_location text)
returns table (supplier text, product_key text, code text, description text, unit text,
               unit_price numeric, invoice_date date)
language sql stable security definer set search_path to 'public'
as $function$
  select distinct on (i.supplier, coalesce(l.code, lower(l.description)))
         i.supplier, coalesce(l.code, lower(l.description)), l.code, l.description, l.unit,
         l.unit_price, i.invoice_date
    from public.supplier_invoice_lines l
    join public.supplier_invoices i on i.id = l.invoice_id
   where i.location = p_location and i.active and i.kind = 'invoice'
     and l.unit_price is not null and l.unit_price > 0
     and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)|^delivery'
   order by i.supplier, coalesce(l.code, lower(l.description)), i.invoice_date desc, i.created_at desc
$function$;

-- Every ingredient with its link and price per kg / l / each, plus the list
-- of products to link to.
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

-- Link (or re-link) an ingredient to a product. p_link: {supplier, product_key,
-- label, pack_count, pack_size, pack_unit}; null unlinks.
create or replace function public.manager_ingredient_cost_save(p_manager_id uuid, p_location text, p_ingredient_id uuid, p_link jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_old public.recipe_ingredient_costs%rowtype;
  v_new public.recipe_ingredient_costs%rowtype;
begin
  if not exists (select 1 from public.recipe_ingredients where id = p_ingredient_id and location = v_location) then
    raise exception 'INGREDIENT_NOT_FOUND';
  end if;
  update public.recipe_ingredient_costs set active = false
   where ingredient_id = p_ingredient_id and active returning * into v_old;
  if p_link is not null and jsonb_typeof(p_link) = 'object' then
    insert into public.recipe_ingredient_costs (location, ingredient_id, supplier, product_key, product_label,
                                                pack_count, pack_size, pack_unit, updated_by)
    values (v_location, p_ingredient_id, trim(p_link->>'supplier'), p_link->>'product_key',
            left(trim(coalesce(p_link->>'label', p_link->>'product_key')), 300),
            (p_link->>'pack_count')::numeric, (p_link->>'pack_size')::numeric, p_link->>'pack_unit', p_manager_id)
    returning * into v_new;
  end if;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('ingredient_cost', p_ingredient_id::text, p_manager_id,
          case when v_old.id is null then null else to_jsonb(v_old) - 'id' end,
          case when v_new.id is null then null else to_jsonb(v_new) - 'id' end);
  return jsonb_build_object('ingredient_id', p_ingredient_id, 'linked', v_new.id is not null);
exception
  when check_violation or invalid_text_representation or not_null_violation or numeric_value_out_of_range then
    raise exception 'INVALID_INPUT';
end $function$;

-- "Made in the kitchen": turn a bought-looking ingredient into its own Prep
-- recipe, and make every recipe that used it use that Prep recipe instead
-- (like Lasagna uses Bolognese). The new recipe starts with the ingredient
-- itself as its only line, so allergens and the "checked" state of every dish
-- stay exactly as they were until the kitchen fills in the real ingredients.
-- Any price link of the ingredient is switched off (the cost will come from
-- the recipe). Replaced lines are kept, switched off.
create or replace function public.manager_ingredient_make_recipe(p_manager_id uuid, p_location text, p_ingredient_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_ing public.recipe_ingredients%rowtype;
  v_recipe public.recipes%rowtype;
  v_line public.recipe_lines%rowtype;
  v_moved integer := 0;
begin
  select * into v_ing from public.recipe_ingredients where id = p_ingredient_id and location = v_location;
  if not found then raise exception 'INGREDIENT_NOT_FOUND'; end if;
  select * into v_recipe from public.recipes
   where location = v_location and active and lower(name) = lower(v_ing.name)
   order by created_at limit 1;
  if found and v_recipe.category not in ('Sauce', 'Dressing', 'Prep') then
    raise exception 'NAME_IS_A_DISH';
  end if;
  if v_recipe.id is null then
    insert into public.recipes (location, name, category, notes, updated_by)
    values (v_location, v_ing.name, 'Prep',
            'To fill in: replace this line with the real ingredients and quantities, and say what one batch makes.',
            p_manager_id)
    returning * into v_recipe;
    insert into public.recipe_lines (recipe_id, ingredient_id, quantity, position)
    values (v_recipe.id, v_ing.id, null, 0);
  end if;
  for v_line in
    select l.* from public.recipe_lines l join public.recipes r on r.id = l.recipe_id
     where l.ingredient_id = v_ing.id and l.active and r.id <> v_recipe.id and r.location = v_location
  loop
    update public.recipe_lines set active = false where id = v_line.id;
    insert into public.recipe_lines (recipe_id, sub_recipe_id, quantity, position)
    values (v_line.recipe_id, v_recipe.id, v_line.quantity, v_line.position);
    v_moved := v_moved + 1;
  end loop;
  update public.recipe_ingredient_costs set active = false where ingredient_id = v_ing.id and active;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('made_here', v_ing.id::text, p_manager_id, to_jsonb(v_ing),
          jsonb_build_object('recipe_id', v_recipe.id, 'recipes_using_it', v_moved));
  return jsonb_build_object('recipe_id', v_recipe.id, 'name', v_recipe.name, 'recipes_using_it', v_moved);
end $function$;

revoke all on function public.mh_invoice_products(text) from public, anon, authenticated;
revoke all on function public.manager_ingredient_costs(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_ingredient_cost_save(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_ingredient_make_recipe(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.manager_ingredient_costs(uuid, text) to service_role;
grant execute on function public.manager_ingredient_cost_save(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.manager_ingredient_make_recipe(uuid, text, uuid) to service_role;
