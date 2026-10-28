-- Rollback of 20261028030000_own_pin.sql. People still waiting to choose a PIN keep their temporary PIN.
drop function if exists public.staff_change_pin(uuid, text, text);
drop function if exists public.mh_pin_must_change(uuid);
drop function if exists public.manager_staff_temp_pin(uuid, uuid);
drop function if exists public.mh_random_free_pin();
alter table public.staff drop column if exists pin_must_change;
