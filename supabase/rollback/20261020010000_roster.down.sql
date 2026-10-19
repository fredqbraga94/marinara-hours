-- Rollback of 20261020010000_roster.sql
-- Removes the roster tables and functions (and the roster data in them).
-- No staff, shift, break or other audit row is touched.
drop function if exists public.manager_roster_week(uuid, text, date);
drop function if exists public.manager_roster_set(uuid, uuid, date, text, time, time);
drop table if exists public.roster_audit;
drop table if exists public.roster_entries;
drop table if exists public.roster_services;
