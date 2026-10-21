-- Recipes (Kitchen) and allergens (Floor).
-- Administrator and Kitchen Manager: full recipes (quantities and method) and
-- editing. Floor Manager: read-only allergen view (what each recipe contains),
-- without quantities or method.
-- Ingredients are shared by name within a unit, so an ingredient's allergens
-- are set (and checked on the label) once and apply to every recipe using it.
-- Additive only: new tables and new functions. Nothing existing changes.

create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  name text not null check (length(trim(name)) between 1 and 80),
  allergens text[] not null default '{}',
  checked boolean not null default false,
  checked_by uuid references public.staff(id),
  checked_at timestamptz,
  note text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recipe_ingredients_allergens_check check (allergens <@ array[
    'gluten','wheat','milk','egg','soy','peanut','tree_nuts','sesame',
    'fish','crustacean','mollusc','lupin','sulphites']::text[])
);
create unique index if not exists recipe_ingredients_name_idx on public.recipe_ingredients (location, lower(name));

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  name text not null check (length(trim(name)) between 1 and 80),
  category text not null default 'Sauce' check (length(category) between 1 and 40),
  makes text check (makes is null or length(makes) <= 80),
  method text check (method is null or length(method) <= 6000),
  notes text check (notes is null or length(notes) <= 1000),
  -- How the dish can be made dairy free / gluten free (empty = not possible or not known).
  dairy_free_note text check (dairy_free_note is null or length(dairy_free_note) <= 200),
  gluten_free_note text check (gluten_free_note is null or length(gluten_free_note) <= 200),
  active boolean not null default true,
  updated_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recipes_place_idx on public.recipes (location, active);

create table if not exists public.recipe_lines (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id),
  -- A line is either an ingredient or another recipe (a sauce or dressing).
  ingredient_id uuid references public.recipe_ingredients(id),
  sub_recipe_id uuid references public.recipes(id),
  quantity text check (quantity is null or length(quantity) <= 80),
  position integer not null default 0,
  active boolean not null default true,  -- replaced lines are kept, switched off
  constraint recipe_lines_one_kind check ((ingredient_id is null) <> (sub_recipe_id is null))
);
create index if not exists recipe_lines_recipe_idx on public.recipe_lines (recipe_id, active, position);

create table if not exists public.recipe_audit (
  id bigint generated always as identity primary key,
  kind text not null,
  ref text not null,
  changed_by uuid references public.staff(id),
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz not null default now()
);

alter table public.recipe_ingredients enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_lines enable row level security;
alter table public.recipe_audit enable row level security;
revoke all on public.recipe_ingredients, public.recipes, public.recipe_lines, public.recipe_audit from anon, authenticated;

-- Who may see full recipes / edit: Administrator and Kitchen Manager.
create or replace function public.mh_recipe_full(p_role text)
returns boolean language sql immutable set search_path to 'public'
as $$ select p_role in ('manager', 'admin', 'kitchen_manager') $$;

create or replace function public.mh_recipe_ingredient_json(i public.recipe_ingredients)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'name', i.name, 'allergens', to_jsonb(i.allergens),
    'checked', i.checked, 'checked_at', i.checked_at, 'note', i.note,
    'used_in', (select count(distinct l.recipe_id) from public.recipe_lines l
                  join public.recipes r on r.id = l.recipe_id
                 where l.ingredient_id = i.id and l.active and r.active))
$function$;

-- A recipe and the sauces/dressings it uses (up to 4 levels deep).
create or replace function public.mh_recipe_tree(p_id uuid)
returns table (rid uuid) language sql stable set search_path to 'public'
as $function$
  with recursive t(rid, depth) as (
    select p_id, 0
    union
    select l.sub_recipe_id, t.depth + 1
      from t join public.recipe_lines l on l.recipe_id = t.rid and l.active
     where l.sub_recipe_id is not null and t.depth < 4)
  select distinct rid from t
$function$;

-- Every allergen in the recipe, including its sauces.
create or replace function public.mh_recipe_allergens(p_id uuid)
returns text[] language sql stable set search_path to 'public'
as $function$
  select coalesce(array_agg(distinct a order by a), '{}')
    from public.mh_recipe_tree(p_id) t
    join public.recipe_lines l on l.recipe_id = t.rid and l.active
    join public.recipe_ingredients i on i.id = l.ingredient_id,
         unnest(i.allergens) a
$function$;

-- Checked = every ingredient (sauces included) was checked on the label, and
-- no recipe in it is still empty ("to be completed").
create or replace function public.mh_recipe_checked(p_id uuid)
returns boolean language sql stable set search_path to 'public'
as $function$
  select not exists (
           select 1 from public.mh_recipe_tree(p_id) t
             join public.recipe_lines l on l.recipe_id = t.rid and l.active
             join public.recipe_ingredients i on i.id = l.ingredient_id
            where not i.checked)
     and not exists (
           select 1 from public.mh_recipe_tree(p_id) t
            where not exists (select 1 from public.recipe_lines l where l.recipe_id = t.rid and l.active))
$function$;

-- One recipe; p_full = false leaves out quantities, method and notes.
create or replace function public.mh_recipe_json(r public.recipes, p_full boolean)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', r.id, 'name', r.name, 'category', r.category, 'updated_at', r.updated_at,
    'dairy_free_note', r.dairy_free_note, 'gluten_free_note', r.gluten_free_note,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ingredient_id', i.id, 'recipe_id', sr.id, 'is_recipe', sr.id is not null,
               'name', coalesce(i.name, sr.name),
               'allergens', case when sr.id is null then to_jsonb(i.allergens)
                                 else to_jsonb(public.mh_recipe_allergens(sr.id)) end,
               'checked', case when sr.id is null then i.checked else public.mh_recipe_checked(sr.id) end)
             || case when p_full then jsonb_build_object('quantity', l.quantity) else '{}'::jsonb end
             order by l.position)
        from public.recipe_lines l
        left join public.recipe_ingredients i on i.id = l.ingredient_id
        left join public.recipes sr on sr.id = l.sub_recipe_id
       where l.recipe_id = r.id and l.active), '[]'::jsonb),
    'allergens', to_jsonb(public.mh_recipe_allergens(r.id)),
    'all_checked', public.mh_recipe_checked(r.id))
  || case when p_full then jsonb_build_object('makes', r.makes, 'method', r.method, 'notes', r.notes)
          else '{}'::jsonb end
$function$;

create or replace function public.manager_recipe_list(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_full boolean := public.mh_recipe_full(mgr.role);
begin
  if mgr.role not in ('manager', 'admin', 'kitchen_manager', 'floor_manager') then raise exception 'GM_REQUIRED'; end if;
  return jsonb_build_object(
    'location', v_location,
    'full', v_full,
    'can_edit', v_full,
    'recipes', coalesce((
      select jsonb_agg(public.mh_recipe_json(r, v_full) order by r.category, r.name)
        from public.recipes r where r.location = v_location and r.active), '[]'::jsonb),
    'ingredients', case when v_full then coalesce((
      select jsonb_agg(public.mh_recipe_ingredient_json(i) order by lower(i.name))
        from public.recipe_ingredients i where i.location = v_location), '[]'::jsonb) else '[]'::jsonb end);
end $function$;

-- Find or create an ingredient by name in a unit.
create or replace function public.mh_recipe_ingredient_id(p_location text, p_name text)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_name text := left(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), 80);
  v_id uuid;
begin
  if v_name = '' then raise exception 'INVALID_INPUT'; end if;
  select id into v_id from public.recipe_ingredients where location = p_location and lower(name) = lower(v_name);
  if v_id is null then
    insert into public.recipe_ingredients (location, name) values (p_location, v_name)
    on conflict (location, lower(name)) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.recipe_ingredients where location = p_location and lower(name) = lower(v_name);
    end if;
  end if;
  return v_id;
end $function$;

-- Add one line. A name that matches a sauce, dressing or prep recipe of the
-- unit becomes a link to that recipe (its allergens then count too);
-- anything else is an ingredient.
create or replace function public.mh_recipe_line_add(
  p_recipe_id uuid, p_location text, p_name text, p_quantity text, p_position integer)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_name text := left(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), 80);
  v_sub uuid;
begin
  if v_name = '' then return; end if;
  select id into v_sub from public.recipes
   where location = p_location and active and id <> p_recipe_id
     and category in ('Sauce', 'Dressing', 'Prep') and lower(name) = lower(v_name)
   order by created_at limit 1;
  insert into public.recipe_lines (recipe_id, ingredient_id, sub_recipe_id, quantity, position)
  values (p_recipe_id,
          case when v_sub is null then public.mh_recipe_ingredient_id(p_location, v_name) end,
          v_sub, nullif(left(trim(coalesce(p_quantity, '')), 80), ''), p_position);
end $function$;

-- Create or update a recipe. p_recipe: {id?, name, category, makes, method,
-- notes, lines: [{name, quantity}]}. The lines replace the old ones.
create or replace function public.manager_recipe_save(p_manager_id uuid, p_location text, p_recipe jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_id uuid := nullif(p_recipe->>'id', '')::uuid;
  v_old public.recipes%rowtype;
  v_row public.recipes%rowtype;
  v_line jsonb;
  v_pos integer := 0;
begin
  if not public.mh_recipe_full(mgr.role) then raise exception 'GM_REQUIRED'; end if;
  if coalesce(trim(p_recipe->>'name'), '') = '' or jsonb_typeof(p_recipe->'lines') <> 'array'
     or jsonb_array_length(p_recipe->'lines') > 60 then
    raise exception 'INVALID_INPUT';
  end if;
  if v_id is not null then
    select * into v_old from public.recipes where id = v_id and location = v_location and active for update;
    if not found then raise exception 'RECIPE_NOT_FOUND'; end if;
    update public.recipes
       set name = trim(p_recipe->>'name'),
           category = coalesce(nullif(trim(p_recipe->>'category'), ''), 'Sauce'),
           makes = nullif(trim(p_recipe->>'makes'), ''),
           method = nullif(trim(p_recipe->>'method'), ''),
           notes = nullif(trim(p_recipe->>'notes'), ''),
           dairy_free_note = nullif(left(trim(coalesce(p_recipe->>'dairy_free_note', '')), 200), ''),
           gluten_free_note = nullif(left(trim(coalesce(p_recipe->>'gluten_free_note', '')), 200), ''),
           updated_by = mgr.id, updated_at = now()
     where id = v_id returning * into v_row;
    update public.recipe_lines set active = false where recipe_id = v_id and active;
  else
    insert into public.recipes (location, name, category, makes, method, notes,
                                dairy_free_note, gluten_free_note, updated_by)
    values (v_location, trim(p_recipe->>'name'),
            coalesce(nullif(trim(p_recipe->>'category'), ''), 'Sauce'),
            nullif(trim(p_recipe->>'makes'), ''), nullif(trim(p_recipe->>'method'), ''),
            nullif(trim(p_recipe->>'notes'), ''),
            nullif(left(trim(coalesce(p_recipe->>'dairy_free_note', '')), 200), ''),
            nullif(left(trim(coalesce(p_recipe->>'gluten_free_note', '')), 200), ''), mgr.id)
    returning * into v_row;
  end if;
  for v_line in select * from jsonb_array_elements(p_recipe->'lines') loop
    continue when coalesce(trim(v_line->>'name'), '') = '';
    perform public.mh_recipe_line_add(v_row.id, v_location, v_line->>'name', v_line->>'quantity', v_pos);
    v_pos := v_pos + 1;
  end loop;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('recipe_save', v_row.id::text, mgr.id,
          case when v_old.id is null then null else to_jsonb(v_old) end,
          public.mh_recipe_json(v_row, true));
  return public.mh_recipe_json(v_row, true);
exception
  when check_violation or invalid_text_representation then raise exception 'INVALID_INPUT';
end $function$;

create or replace function public.manager_recipe_remove(p_manager_id uuid, p_location text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_row public.recipes%rowtype;
begin
  if not public.mh_recipe_full(mgr.role) then raise exception 'GM_REQUIRED'; end if;
  update public.recipes set active = false, updated_by = mgr.id, updated_at = now()
   where id = p_id and location = v_location and active returning * into v_row;
  if not found then raise exception 'RECIPE_NOT_FOUND'; end if;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('recipe_remove', p_id::text, mgr.id, public.mh_recipe_json(v_row, true), null);
  return jsonb_build_object('id', p_id, 'active', false);
end $function$;

-- Set an ingredient's allergens and whether they were checked on the label.
create or replace function public.manager_recipe_ingredient_save(
  p_manager_id uuid, p_location text, p_id uuid, p_allergens jsonb, p_checked boolean, p_note text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_old public.recipe_ingredients%rowtype;
  v_row public.recipe_ingredients%rowtype;
  v_list text[];
begin
  if not public.mh_recipe_full(mgr.role) then raise exception 'GM_REQUIRED'; end if;
  if jsonb_typeof(p_allergens) <> 'array' then raise exception 'INVALID_INPUT'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_list from jsonb_array_elements_text(p_allergens) x;
  select * into v_old from public.recipe_ingredients where id = p_id and location = v_location for update;
  if not found then raise exception 'RECIPE_NOT_FOUND'; end if;
  update public.recipe_ingredients
     set allergens = v_list,
         checked = coalesce(p_checked, false),
         checked_by = case when coalesce(p_checked, false) then mgr.id else null end,
         checked_at = case when coalesce(p_checked, false) then now() else null end,
         note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
         updated_at = now()
   where id = p_id returning * into v_row;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('ingredient_save', p_id::text, mgr.id, to_jsonb(v_old), to_jsonb(v_row));
  return public.mh_recipe_ingredient_json(v_row);
exception
  when check_violation then raise exception 'INVALID_INPUT';
end $function$;

revoke all on function public.mh_recipe_full(text) from public, anon, authenticated;
revoke all on function public.mh_recipe_ingredient_json(public.recipe_ingredients) from public, anon, authenticated;
revoke all on function public.mh_recipe_json(public.recipes, boolean) from public, anon, authenticated;
revoke all on function public.mh_recipe_ingredient_id(text, text) from public, anon, authenticated;
revoke all on function public.mh_recipe_line_add(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.mh_recipe_tree(uuid) from public, anon, authenticated;
revoke all on function public.mh_recipe_allergens(uuid) from public, anon, authenticated;
revoke all on function public.mh_recipe_checked(uuid) from public, anon, authenticated;
revoke all on function public.manager_recipe_list(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_recipe_save(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.manager_recipe_remove(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.manager_recipe_ingredient_save(uuid, text, uuid, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function public.manager_recipe_list(uuid, text) to service_role;
grant execute on function public.manager_recipe_save(uuid, text, jsonb) to service_role;
grant execute on function public.manager_recipe_remove(uuid, text, uuid) to service_role;
grant execute on function public.manager_recipe_ingredient_save(uuid, text, uuid, jsonb, boolean, text) to service_role;

-- First recipes for Hawthorne (from the kitchen's sheets). Every ingredient
-- starts as NOT checked: the kitchen confirms each one on the product label.
-- Only milk products are pre-marked with Milk.
do $seed$
declare
  v_rec record;
  v_id uuid;
  v_pos integer;
  v_line text[];
begin
  if exists (select 1 from public.recipes where location = 'Hawthorne') then return; end if;
  for v_rec in select * from (values
    ('Creamy Chicken Sauce', 'Sauce', 'One large batch',
     E'1. Heat the milk gently in a large saucepan over medium heat. Add the cream and stir until combined.\n2. Gradually add the thickening agent (or butter), stirring constantly.\n3. Once melted, slowly add the corn flour, whisking continuously to avoid lumps.\n4. Stir in the chicken booster and onion powder. Simmer, stirring, until it thickens.\n5. Taste and adjust the seasoning. Simmer another 5–10 minutes, stirring occasionally.',
     array[array['Milk','9 bottles'], array['Cream','1 container'], array['Thickening agent','1.9 kg (or 1 kg butter)'],
           array['Corn flour','900 g'], array['Chicken booster','6 chef spoons'], array['Onion powder','2 chef spoons']]),
    ('Bolognese', 'Sauce', '10 kg mince batch',
     E'1. Brown the mince in a large pan over medium heat until fully cooked. Drain excess fat if needed.\n2. Stir in the onion powder.\n3. Add the demi glaze, stirring until the mince is evenly coated.\n4. Add the tomato sauce so the mince is covered. Simmer about 20 minutes, stirring occasionally.\n5. Add nutmeg to taste and adjust the seasoning.\n6. Simmer another 10 minutes.',
     array[array['Mince','10 kg'], array['Demi glaze','14 chef spoons'], array['Onion powder','4 chef spoons'],
           array['Tomato sauce','5 litres'], array['Nutmeg','to taste']]),
    ('Chilli Oil', 'Sauce', 'One small jar',
     E'1. In a small bowl, combine the paprika, chilli paste and chilli flakes.\n2. Gradually add the olive oil, stirring continuously.\n3. Transfer to a clean airtight jar and shake well.\n4. Leave to infuse at least 24 hours before use.',
     array[array['Paprika','2 dessert spoons'], array['Chilli paste','2 dessert spoons'], array['Chilli flakes','2 dessert spoons'],
           array['Tuscan olive oil','2 dessert spoons']])
  ) as t(name, category, makes, method, lines) loop
    insert into public.recipes (location, name, category, makes, method)
    values ('Hawthorne', v_rec.name, v_rec.category, v_rec.makes, v_rec.method) returning id into v_id;
    v_pos := 0;
    foreach v_line slice 1 in array v_rec.lines loop
      insert into public.recipe_lines (recipe_id, ingredient_id, quantity, position)
      values (v_id, public.mh_recipe_ingredient_id('Hawthorne', v_line[1]), v_line[2], v_pos);
      v_pos := v_pos + 1;
    end loop;
  end loop;
  update public.recipe_ingredients set allergens = array['milk'] where location = 'Hawthorne' and name in ('Milk', 'Cream');
end $seed$;

-- Hawthorne menu (from the printed menu). Ingredients come from the menu
-- descriptions; the sauces the menu names start empty ("to be completed" by the
-- chefs), so every dish stays "Not checked yet" until the kitchen fills them in
-- and checks the labels. Obvious allergens are pre-marked (still not checked).
do $menu$
declare
  v_rec record;
  v_id uuid;
  v_pos integer;
  v_part text;
begin
  if exists (select 1 from public.recipes where location = 'Hawthorne' and name = 'Margherita') then return; end if;

  -- Sauces and dressings named on the menu (empty for now).
  insert into public.recipes (location, name, category, method)
  select 'Hawthorne', n, c, 'To be completed by the kitchen.'
    from (values
      ('Napoli sauce','Sauce'), ('Pesto sauce','Sauce'), ('Kilpatrick sauce','Sauce'), ('Mornay sauce','Sauce'),
      ('White sauce','Sauce'), ('Funghi sauce','Sauce'), ('Marsala cream sauce','Sauce'), ('Pepe verde sauce','Sauce'),
      ('Lemon sauce','Sauce'), ('Tuscan sauce','Sauce'), ('Bearnaise sauce','Sauce'),
      ('House dressing','Dressing'), ('Citrus dressing','Dressing'), ('Honey mustard dressing','Dressing')
    ) as t(n, c)
   where not exists (select 1 from public.recipes r where r.location = 'Hawthorne' and lower(r.name) = lower(t.n));

  for v_rec in select * from (values
    -- name, category, ingredients (| separated), gluten-free note
    ('Garlic Bread','Pane','Ciabatta bread|Garlic butter', null),
    ('Cheesy Garlic Pizza Bread','Pane','Pizza dough|Olive oil|Garlic|Oregano|Cracked pepper|Mozzarella', null),
    ('Bruschetta Pizza Bread','Pane','Pizza dough|Olive oil|Tomato|Basil|Red onion', null),
    ('Warm Seafood Salad','Salad','Prawns|Mussels|Calamari|Salmon|Garden salad|Citrus dressing', null),
    ('Lemon Pepper Chicken','Salad','Lemon pepper chicken|Mixed leaves|Carrot|Red onion|Capsicum|Tomato|Cucumber|Honey mustard dressing', null),
    ('Italian Salad','Salad','Mixed lettuce|Red onion|Olives|Capsicum|Fresh herbs|Mushrooms|Cucumber|Tomato|Carrot|House dressing', null),
    ('Insalata Caprese','Salad','Tomato|Bocconcini|Basil|Red onion|Balsamic vinegar|Olive oil', null),
    ('Natural Oysters','Entrée','Oysters|Lemon juice|Shallots', null),
    ('Kilpatrick Oysters','Entrée','Oysters|Kilpatrick sauce', null),
    ('Oyster Mornay','Entrée','Oysters|Mornay sauce', null),
    ('Garlic Prawn Classico','Entrée','Prawns|Garlic butter|Cracked pepper|Parsley|Lemon juice', null),
    ('Mussel Napoletana','Entrée','Mussels|White wine|Napoli sauce|Mozzarella', null),
    ('Tuscan Baked Salmon','Seafood','Salmon|Kipfler potatoes|Mushrooms|Napoli sauce|Mozzarella', null),
    ('Calamari al Limone','Seafood','Calamari|Garlic|Olive oil|Chilli flakes|Lemon|Parsley|Rice|Rocket', null),
    ('Risotto Marinara','Seafood','Arborio rice|Fish|Prawns|Scallops|Baby clams|Mussels|Fresh herbs|Tomato', null),
    ('Scaloppine al Limone','Scaloppine','Scaloppine|Lemon sauce|Fettuccine', null),
    ('Scaloppine ai Funghi','Scaloppine','Scaloppine|Mushrooms|White sauce|Fettuccine', null),
    ('Scaloppine al Marsala','Scaloppine','Scaloppine|Marsala cream sauce|Fettuccine', null),
    ('Scaloppine alla Zingala','Scaloppine','Scaloppine|Chilli|Tomato|Onion|Capsicum|Shallots|Parmesan|Cream|Fettuccine', null),
    ('Steak ai Funghi','Steak','Eye fillet steak|Kipfler potatoes|Broccolini|Truss tomatoes|Funghi sauce', null),
    ('Steak Pepe Verde','Steak','Eye fillet steak|Cracked pepper|Kipfler potatoes|Broccolini|Truss tomatoes|Pepe verde sauce', null),
    ('Fettuccine Don Carlos','Pasta','Fettuccine|Prawns|Chilli|Garlic|Olive oil|Shallots|Tomato|Parsley', 'Gluten-free pasta (extra charge)'),
    ('Fettuccine Carbonara','Pasta','Fettuccine|Bacon|Mushrooms|Onion|Cream|Parmesan', 'Gluten-free pasta (extra charge)'),
    ('Fettuccine Marinara','Pasta','Fettuccine|Prawns|Baby clams|Scallops|Mussels|Tomato|Garlic|Cream|Fresh herbs', 'Gluten-free pasta (extra charge)'),
    ('Fettuccine al Pollo','Pasta','Fettuccine|Chicken|Mushrooms|White sauce|Parmesan', 'Gluten-free pasta (extra charge)'),
    ('Penne Matriciana','Pasta','Penne|Onion|Bacon|Garlic|Tomato|Chilli|Cream', 'Gluten-free pasta (extra charge)'),
    ('Chicken Penne Pesto','Pasta','Penne|Chicken tenderloin|Pesto sauce|Cream', 'Gluten-free pasta (extra charge)'),
    ('Baked Spinach & Ricotta Ravioli','Pasta','Spinach & ricotta ravioli|Tuscan sauce|Vegetables', null),
    ('Lasagna al Forno','Pasta','Lasagne sheets|Bolognese|Tomato|Mozzarella', null),
    ('Cannelloni','Pasta','Cannelloni|Mince|Mushrooms|Mozzarella|Cream|Napoli sauce', null),
    ('Gnocchi Bolognese / Napoli','Pasta','Gnocchi|Bolognese|Napoli sauce|Mozzarella|Fresh herbs', null),
    ('Margherita','Pizza','Pizza dough|Tomato base|Mozzarella|Oregano', 'Gluten-free base (extra charge)'),
    ('Paradiso','Pizza','Pizza dough|Tomato base|Mozzarella|Ham|Pineapple', 'Gluten-free base (extra charge)'),
    ('Vesuvio','Pizza','Pizza dough|Tomato base|Mozzarella|Ham', 'Gluten-free base (extra charge)'),
    ('Pepperoni Pizza','Pizza','Pizza dough|Tomato base|Mozzarella|Pepperoni', 'Gluten-free base (extra charge)'),
    ('Napoletana','Pizza','Pizza dough|Tomato base|Olives|Anchovies|Mozzarella|Fresh herbs', 'Gluten-free base (extra charge)'),
    ('Capricciosa','Pizza','Pizza dough|Tomato base|Ham|Mozzarella|Mushrooms', 'Gluten-free base (extra charge)'),
    ('Chilli Prawn Pizza','Pizza','Pizza dough|Tomato base|Prawns|Chilli|Mozzarella|Red onion|Fresh herbs', 'Gluten-free base (extra charge)'),
    ('Vegetarian Pizza','Pizza','Pizza dough|Tomato base|Mozzarella|Onion|Mushrooms|Capsicum|Olives|Corn kernels|Spinach|Fetta', 'Gluten-free base (extra charge)'),
    ('Supreme','Pizza','Pizza dough|Tomato base|Ham|Mozzarella|Pepperoni|Onion|Capsicum|Olives|Mushrooms', 'Gluten-free base (extra charge)'),
    ('Marinara Pizza','Pizza','Pizza dough|Tomato base|Mozzarella|Prawns|Baby clams|Mussels|Oysters|Fresh herbs', 'Gluten-free base (extra charge)'),
    ('Prosciutto & Rocket','Pizza','Pizza dough|Tomato base|Red onion|Bocconcini|Prosciutto|Rocket|Lemon juice', 'Gluten-free base (extra charge)'),
    ('Calzone','Pizza','Pizza dough|Tomato base|Ham|Chicken|Pepperoni|Chorizo|Napoli sauce|Bolognese|Mozzarella', 'Gluten-free base (extra charge)'),
    ('Mediterranean','Pizza','Pizza dough|Tomato base|Capsicum|Zucchini|Eggplant|Sundried tomato|Fetta|Mozzarella|Red onion|Olives|Fresh herbs', 'Gluten-free base (extra charge)'),
    ('Chicken Avocado','Pizza','Pizza dough|Tomato base|BBQ chicken|Avocado|Fetta|Sundried tomato|Rocket|Mozzarella', 'Gluten-free base (extra charge)'),
    ('House Special','Pizza','Pizza dough|Tomato base|Scaloppine|Tomato|Mozzarella|Mushrooms|Bearnaise sauce|Fresh herbs', 'Gluten-free base (extra charge)'),
    ('Meat Lovers','Pizza','Pizza dough|Tomato base|Mozzarella|Pepperoni|Chicken|Ham|Bolognese', 'Gluten-free base (extra charge)'),
    ('Chicken & Chorizo','Pizza','Pizza dough|Tomato base|Mozzarella|Chicken|Chorizo', 'Gluten-free base (extra charge)'),
    ('Risotto ai Funghi','Vegetarian','Arborio rice|Mushrooms|Garlic|White wine|Cream|Truffle oil|Parmesan', null),
    ('Fettuccine Verde','Vegetarian','Fettuccine|Vegetables|Olive oil|Garlic|Chilli|Fresh herbs', 'Gluten-free pasta (extra charge)'),
    ('Kids Pasta (plain or cheese & butter)','Kids','Fettuccine, penne or gnocchi|Parmesan|Butter', 'Gluten-free pasta (extra charge)')
  ) as t(name, category, parts, gf) loop
    insert into public.recipes (location, name, category, gluten_free_note, notes)
    values ('Hawthorne', v_rec.name, v_rec.category, v_rec.gf,
            case when v_rec.category in ('Pasta', 'Vegetarian', 'Kids') then 'Most dishes are served with shredded cheese.' end)
    returning id into v_id;
    v_pos := 0;
    foreach v_part in array string_to_array(v_rec.parts, '|') loop
      perform public.mh_recipe_line_add(v_id, 'Hawthorne', v_part, null, v_pos);
      v_pos := v_pos + 1;
    end loop;
  end loop;

  -- Pre-mark the obvious allergens (still NOT checked: the kitchen confirms).
  update public.recipe_ingredients i set allergens = m.a, updated_at = now()
    from (values
      ('Ciabatta bread', array['gluten','wheat']), ('Pizza dough', array['gluten','wheat']),
      ('Fettuccine', array['gluten','wheat']), ('Penne', array['gluten','wheat']),
      ('Lasagne sheets', array['gluten','wheat']), ('Cannelloni', array['gluten','wheat']),
      ('Gnocchi', array['gluten','wheat']), ('Fettuccine, penne or gnocchi', array['gluten','wheat']),
      ('Spinach & ricotta ravioli', array['gluten','milk','wheat']),
      ('Mozzarella', array['milk']), ('Parmesan', array['milk']), ('Cream', array['milk']),
      ('Fetta', array['milk']), ('Bocconcini', array['milk']), ('Garlic butter', array['milk']),
      ('Butter', array['milk']),
      ('Prawns', array['crustacean']),
      ('Mussels', array['mollusc']), ('Baby clams', array['mollusc']), ('Scallops', array['mollusc']),
      ('Oysters', array['mollusc']), ('Calamari', array['mollusc']),
      ('Salmon', array['fish']), ('Fish', array['fish']), ('Anchovies', array['fish'])
    ) as m(n, a)
   where i.location = 'Hawthorne' and i.name = m.n and not i.checked and i.allergens = '{}';
end $menu$;
