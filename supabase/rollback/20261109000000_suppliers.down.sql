-- Rollback of 20261109000000_suppliers.sql (the Suppliers list goes away).
drop function if exists public.manager_supplier_remove(uuid, uuid);
drop function if exists public.manager_supplier_save(uuid, jsonb);
drop function if exists public.manager_supplier_list(uuid);
drop function if exists public.mh_supplier_json(public.suppliers);
drop table if exists public.suppliers;
