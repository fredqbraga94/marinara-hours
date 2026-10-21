-- Rollback of 20261022000000_recipes.sql (removes recipes and allergens).
drop function if exists public.manager_recipe_ingredient_save(uuid, text, uuid, jsonb, boolean, text);
drop function if exists public.manager_recipe_remove(uuid, text, uuid);
drop function if exists public.manager_recipe_save(uuid, text, jsonb);
drop function if exists public.manager_recipe_list(uuid, text);
drop function if exists public.mh_recipe_ingredient_id(text, text);
drop function if exists public.mh_recipe_json(public.recipes, boolean);
drop function if exists public.mh_recipe_ingredient_json(public.recipe_ingredients);
drop function if exists public.mh_recipe_full(text);
drop table if exists public.recipe_lines;
drop table if exists public.recipe_audit;
drop table if exists public.recipes;
drop table if exists public.recipe_ingredients;
