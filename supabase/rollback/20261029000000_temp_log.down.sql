-- Rollback of 20261029000000_temp_log.sql. WARNING: the temperature records go away; export them first.
drop function if exists public.manager_temp_history(uuid, integer);
drop function if exists public.manager_temp_record(uuid, jsonb);
drop function if exists public.manager_temp_equipment_save(uuid, jsonb);
drop function if exists public.manager_temp_today(uuid);
drop function if exists public.mh_temp_log_json(public.temp_logs);
drop function if exists public.mh_temp_ok(text, numeric);
drop table if exists public.temp_logs;
drop table if exists public.temp_equipment;
