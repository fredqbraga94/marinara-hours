-- Phase 3a (observe-only): detect PINs shared by more than one active account
-- WITHOUT revealing any PIN.
--
-- Additive and read-only: one new function, no table or data changes.
-- It is called only after a successful login, with the PIN the person just
-- typed, and returns only a number (how many active accounts use that PIN).
-- It cannot list PINs, returns no names and changes nothing.
-- Only the Edge Function (service_role) may call it.
--
-- Rollback: drop function public.pin_match_count(text);

create or replace function public.pin_match_count(p_pin text)
returns integer
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
  select count(*)::integer
  from public.staff s
  where s.active = true
    and p_pin ~ '^[0-9]{4,6}$'
    and s.pin_hash = extensions.crypt(p_pin, s.pin_hash);
$function$;

revoke all on function public.pin_match_count(text) from public, anon, authenticated;
grant execute on function public.pin_match_count(text) to service_role;
