-- Rollback of 20261111000000_supplier_compare.sql (Compare suppliers goes away).
drop function if exists public.manager_supplier_compare_save(uuid, text, jsonb);
drop function if exists public.manager_supplier_compare(uuid, text);
drop table if exists public.supplier_product_compare;
