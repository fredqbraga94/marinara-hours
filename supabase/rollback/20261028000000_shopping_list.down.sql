-- Rollback of 20261028000000_shopping_list.sql (the shopping list and its items go away).
drop function if exists public.manager_shopping_mark(uuid, uuid, text);
drop function if exists public.manager_shopping_save(uuid, jsonb);
drop function if exists public.manager_shopping_list(uuid);
drop function if exists public.mh_shopping_json(public.shopping_items);
drop table if exists public.shopping_items;
