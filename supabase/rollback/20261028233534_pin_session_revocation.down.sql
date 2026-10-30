-- Roll back the Edge handler first. This restores the old session-retention risk.
-- No employee, shift or audit rows are removed.
drop function if exists public.staff_change_pin_secure(uuid,text,text,text);

-- Restore exactly the original employee lookup if this patch is present.
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
  if strpos(source, new_fragment) > 0 then
    execute replace(source, new_fragment, old_fragment);
  elsif strpos(source, old_fragment) = 0 then
    raise exception 'LOGIN_SOURCE_CHANGED';
  end if;
end $migration$;
