-- Rollback of 20261021020000_roster_order.sql
-- The roster goes back to alphabetical order inside each role.
drop function if exists public.manager_set_roster_order_audited(uuid, jsonb);
alter table public.staff drop column if exists roster_order;
