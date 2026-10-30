-- Rollback of 20261031000000_food_safety.sql. WARNING: the food temperature and cleaning records go away; export them first.
drop function if exists public.manager_clean_history(uuid, integer);
drop function if exists public.manager_clean_mark(uuid, uuid, boolean, text);
drop function if exists public.manager_clean_task_save(uuid, jsonb);
drop function if exists public.manager_clean_week(uuid, date);
drop function if exists public.manager_food_history(uuid, integer);
drop function if exists public.manager_food_edit(uuid, uuid, jsonb);
drop function if exists public.manager_food_record(uuid, jsonb);
drop function if exists public.manager_food_day(uuid, date);
drop function if exists public.mh_food_json(public.food_temps);
drop function if exists public.mh_food_ok(text, integer, numeric, numeric);
drop table if exists public.cleaning_logs;
drop table if exists public.cleaning_tasks;
drop table if exists public.food_temps;
