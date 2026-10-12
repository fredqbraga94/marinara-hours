-- Atomic PIN attempt limiting + safe PIN login.
-- Additive only: new functions, no table or data changes.
--
-- Why: login_with_pin returns an empty set (not an error) for a wrong PIN.
-- The Edge Function treated that as success and reset the counter, so the
-- lockout never triggered. These functions reserve each attempt atomically
-- (row lock) BEFORE the PIN is checked, so parallel requests cannot exceed
-- the limit, and login_with_pin_v2 refuses a PIN shared by two accounts
-- instead of logging in as an arbitrary one.

create or replace function public.pin_attempt_reserve(
  p_key text,
  p_max integer,
  p_window_minutes integer,
  p_lock_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.pin_attempts%rowtype;
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_key is null or btrim(p_key) = '' or p_max is null or p_max < 1
     or p_window_minutes is null or p_window_minutes < 1
     or p_lock_minutes is null or p_lock_minutes < 1 then
    raise exception 'INVALID_INPUT';
  end if;

  insert into public.pin_attempts (attempt_key, failed_attempts, locked_until, last_attempt_at)
  values (p_key, 0, null, v_now)
  on conflict (attempt_key) do nothing;

  -- Serialises concurrent attempts for the same key.
  select * into r from public.pin_attempts where attempt_key = p_key for update;

  if r.locked_until is not null and r.locked_until > v_now then
    return jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (r.locked_until - v_now))))::integer,
      'remaining', 0
    );
  end if;

  v_count := coalesce(r.failed_attempts, 0);

  -- Expired lock, or no attempts for a whole window: start again.
  if r.locked_until is not null
     or r.last_attempt_at is null
     or r.last_attempt_at < v_now - make_interval(mins => p_window_minutes) then
    v_count := 0;
  end if;

  v_count := v_count + 1;

  if v_count > p_max then
    update public.pin_attempts
    set failed_attempts = p_max,
        locked_until = v_now + make_interval(mins => p_lock_minutes),
        last_attempt_at = v_now
    where id = r.id;

    return jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', p_lock_minutes * 60,
      'remaining', 0
    );
  end if;

  update public.pin_attempts
  set failed_attempts = v_count,
      locked_until = null,
      last_attempt_at = v_now
  where id = r.id;

  return jsonb_build_object(
    'allowed', true,
    'retry_after_seconds', 0,
    'remaining', p_max - v_count
  );
end;
$function$;

-- Called after a reserved attempt turned out to be legitimate.
-- p_clear = true resets the key (per-device key after a correct PIN);
-- p_clear = false gives back one attempt (global key after a correct PIN,
-- or any key when the server failed before the PIN could be checked).
create or replace function public.pin_attempt_release(
  p_key text,
  p_clear boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_clear then
    update public.pin_attempts
    set failed_attempts = 0, locked_until = null
    where attempt_key = p_key;
  else
    update public.pin_attempts
    set failed_attempts = greatest(0, failed_attempts - 1)
    where attempt_key = p_key
      and (locked_until is null or locked_until <= clock_timestamp());
  end if;
end;
$function$;

-- Same columns as login_with_pin, but returns up to two matches so the
-- caller can refuse a PIN that belongs to more than one active account.
create or replace function public.login_with_pin_v2(p_pin text)
returns table(staff_id uuid, staff_name text, staff_role text, department text, location text)
language sql
security definer
set search_path to 'public', 'extensions'
as $function$
  select s.id, s.name, s.role, s.department, s.location
  from public.staff s
  where s.active = true
    and p_pin ~ '^[0-9]{4,6}$'
    and s.pin_hash = extensions.crypt(p_pin, s.pin_hash)
  limit 2;
$function$;

revoke all on function public.pin_attempt_reserve(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.pin_attempt_release(text, boolean) from public, anon, authenticated;
revoke all on function public.login_with_pin_v2(text) from public, anon, authenticated;
grant execute on function public.pin_attempt_reserve(text, integer, integer, integer) to service_role;
grant execute on function public.pin_attempt_release(text, boolean) to service_role;
grant execute on function public.login_with_pin_v2(text) to service_role;
