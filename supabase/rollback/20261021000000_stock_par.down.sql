-- Rollback of 20261021000000_stock_par.sql
-- Removes the stock tables and functions (and the stock data in them).
-- No staff, shift, break, roster, leave or other audit row is touched.
drop function if exists public.manager_stock_count_close(uuid, text, text);
drop function if exists public.manager_stock_count_save(uuid, text, text, jsonb);
drop function if exists public.manager_stock_supplier_save(uuid, text, text, text, integer, text);
drop function if exists public.manager_stock_item_remove(uuid, text, uuid);
drop function if exists public.manager_stock_item_save(uuid, text, jsonb);
drop function if exists public.manager_stock_list(uuid, text, text);
drop function if exists public.mh_stock_item_json(public.stock_items);
drop function if exists public.mh_stock_department(text, text);
drop function if exists public.mh_stock_order(numeric, numeric, numeric, numeric, integer, text);
drop table if exists public.stock_audit;
drop table if exists public.stock_counts;
drop table if exists public.stock_items;
drop table if exists public.stock_suppliers;
