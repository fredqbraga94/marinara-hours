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

-- Preserve the deployed login definition and ACL, changing only its employee
-- lookup. Abort if the expected baseline fragment has changed; never patch an
-- unknown production function silently. No rows are modified by this DDL.
do $migration$
declare
  source text := pg_get_functiondef('public.auth_pin_login(text,text,text,timestamptz)'::regprocedure);
  old_fragment text := $old$  select * into st from public.staff where id = v_matches[1];$old$;
  new_fragment text := $new$  -- Serialize session creation with PIN changes/resets on this employee.
  -- A login may have scanned the old hash before waiting for this row lock.
  select * into st from public.staff where id = v_matches[1] for no key update;
  if not found or st.active is distinct from true
     or st.pin_hash is distinct from extensions.crypt(p_pin, st.pin_hash) then
    v_fail := public.auth_bucket_fail(v_bucket, v_short, v_daily, cfg.short_window_minutes);
    return jsonb_build_object('result', 'invalid_pin',
      'device', case when dev.id is null then 'unknown' else 'approved' end) || v_fail;
  end if;$new$;
begin
  if strpos(source, new_fragment) > 0 then return; end if;
  if strpos(source, old_fragment) = 0 then raise exception 'LOGIN_SOURCE_CHANGED'; end if;
  execute replace(source, old_fragment, new_fragment);
end $migration$;
