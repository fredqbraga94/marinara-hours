-- Rollback of 20261027010000_manager_permissions.sql (every manager goes back to
-- what their role gives). staff_audit rows about permissions are kept.
drop function if exists public.manager_update_staff_with_access(uuid, uuid, text, text, text, text, jsonb);
drop function if exists public.manager_permissions_set(uuid, uuid, jsonb);
drop function if exists public.manager_permissions_list(uuid);
drop function if exists public.manager_permissions_mine(uuid);
drop table if exists public.manager_permissions;
