-- Rollback of 20261031010000_activity_log.sql. Read-only functions: no records are lost.
drop function if exists public.manager_activity(uuid, integer, uuid);
drop function if exists public.mh_act_span(text, text);
drop function if exists public.mh_act_loc(uuid);
drop function if exists public.mh_act_name(uuid);
