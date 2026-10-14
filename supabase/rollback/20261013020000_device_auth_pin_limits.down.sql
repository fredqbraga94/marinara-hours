-- Rollback of 20261013020000_device_auth_pin_limits.sql
-- Only needed if the database itself must return to the v37 state; v37 runs
-- unchanged with this migration in place (tested), so a normal rollback of
-- v38 is "redeploy the v37 Edge Function" and nothing else.
-- Removes device authorisations, attempt counters, pairing codes and security
-- events. No staff, shift, break or audit row is touched. Existing sessions
-- stay valid (only their device link is removed).

alter table public.staff_sessions drop column if exists device_id;

drop function if exists public.auth_device_status(text);
drop function if exists public.auth_set_mode(uuid, text);
drop function if exists public.auth_rename_device(uuid, uuid, text);
drop function if exists public.auth_unlock_device(uuid, uuid);
drop function if exists public.auth_revoke_device(uuid, uuid);
drop function if exists public.auth_list_devices(uuid, text);
drop function if exists public.auth_owner_pairing_code(text);
drop function if exists public.auth_redeem_pairing_code(text, text, text);
drop function if exists public.auth_create_pairing_code(uuid, text, text);
drop function if exists public.auth_session(text, text);
drop function if exists public.auth_pin_login(text, text, text, timestamptz);
drop function if exists public.auth_bucket_fail(text, integer, integer, integer);
drop function if exists public.auth_bucket_lock(text);

drop table if exists public.auth_events;
drop table if exists public.auth_pairing_codes;
drop table if exists public.auth_attempt_buckets;
drop table if exists public.auth_devices;
drop table if exists public.auth_settings;
