-- PIN changes and revocation of other sessions must commit together.
-- Keeps the initiating session, so the existing PIN dialog and clock flow stay unchanged.
-- Server-only wrapper: no direct access for publishable/anonymous clients.
create or replace function public.staff_change_pin_secure(
  p_staff_id uuid, p_old_pin text, p_new_pin text, p_token_hash text
) returns jsonb
language plpgsql security definer
set search_path to 'public', 'extensions'
as $function$
declare changed jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.staff_sessions s
     where s.staff_id = p_staff_id and s.token_hash = p_token_hash
       and s.revoked_at is null and s.expires_at > now()
  ) then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;
  changed := public.staff_change_pin(p_staff_id, p_old_pin, p_new_pin);
  if coalesce((changed->>'ok')::boolean, false) then
    update public.staff_sessions
       set revoked_at = now()
     where staff_id = p_staff_id and token_hash <> p_token_hash and revoked_at is null;
  end if;
  return changed;
end $function$;
revoke all on function public.staff_change_pin_secure(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.staff_change_pin_secure(uuid,text,text,text) to service_role;
