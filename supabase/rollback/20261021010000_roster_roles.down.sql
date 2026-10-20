-- Rollback of 20261021010000_roster_roles.sql
-- Removes the roster role functions, the per-role service times and the two
-- staff columns. Roster-only people stay in the staff list as ordinary
-- (inactive-PIN) staff; deactivate them in Team if they should not show.
-- No shift, break, roster entry, leave or audit row is touched.
drop function if exists public.manager_create_roster_person_audited(uuid, text, text, text);
drop function if exists public.manager_set_roster_info_audited(uuid, uuid, text, boolean);
drop function if exists public.mh_position_ok(text, text);
drop table if exists public.roster_position_services;
alter table public.staff drop column if exists roster_only;
alter table public.staff drop column if exists position;
