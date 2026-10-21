-- Rollback of 20261022040000_ingredient_costs.sql (removes ingredient cost links).
-- Prep recipes made with "Made in the kitchen" stay (they are ordinary recipes).
drop function if exists public.manager_ingredient_make_recipe(uuid, text, uuid);
drop function if exists public.manager_ingredient_cost_save(uuid, text, uuid, jsonb);
drop function if exists public.manager_ingredient_costs(uuid, text);
drop function if exists public.mh_invoice_products(text);
drop table if exists public.recipe_ingredient_costs;
