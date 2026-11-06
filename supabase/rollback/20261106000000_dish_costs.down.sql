-- Undo 20261106000000_dish_costs.sql: removes the dish cost functions and tables
-- (menu prices, portions and hand-typed prices are lost). Nothing else changes.
drop function if exists public.manager_cost_price_save(uuid, text, text, uuid, jsonb);
drop function if exists public.manager_dish_cost_save(uuid, text, uuid, jsonb);
drop function if exists public.manager_dish_costs(uuid, text);
drop function if exists public.mh_cost_products(text);
drop table if exists public.cost_manual_prices;
drop table if exists public.dish_portions;
drop table if exists public.dish_costing;
