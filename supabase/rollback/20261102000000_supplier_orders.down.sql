-- Rollback of 20261102000000_supplier_orders.sql. WARNING: the order lists and saved orders go away.
drop function if exists public.manager_order_save(uuid, jsonb);
drop function if exists public.manager_order_item_save(uuid, jsonb);
drop function if exists public.manager_order_list(uuid, text);
drop table if exists public.supplier_orders;
drop table if exists public.supplier_order_items;
