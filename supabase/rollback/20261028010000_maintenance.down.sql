-- Rollback of 20261028010000_maintenance.sql (the maintenance list and its items go away).
drop function if exists public.manager_maintenance_mark(uuid, uuid, text, text);
drop function if exists public.manager_maintenance_save(uuid, jsonb);
drop function if exists public.manager_maintenance_list(uuid);
drop function if exists public.mh_maintenance_json(public.maintenance_items);
drop table if exists public.maintenance_items;
