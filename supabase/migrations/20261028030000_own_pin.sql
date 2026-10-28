-- Own PIN: a manager creates a person (or resets a forgotten PIN) and the app
-- gives a one-time temporary PIN, different for every person (a PIN identifies
-- the person at login, so two people can never share one). The person must
-- choose their own PIN at the first login; until then every other action is
-- refused. A person can also change their own PIN later.
-- Additive: one column on staff and five new functions. Login is unchanged.

alter table public.staff add column if not exists pin_must_change boolean not null default false;

-- A random 6-digit PIN that nobody active uses.
create or replace function public.mh_random_free_pin()
returns text language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare p text; i integer := 0;
begin
  loop
    p := lpad((100000 + floor(random() * 900000))::integer::text, 6, '0');
    exit when not public.mh_pin_in_use(p, null);
    i := i + 1;
    if i > 50 then raise exception 'NO_FREE_PIN'; end if;
  end loop;
  return p;
end $$;

-- Manager: give a person a new temporary PIN (new person or forgotten PIN).
-- Returns the PIN once; only its hash is stored. Their open sessions end.
create or replace function public.manager_staff_temp_pin(p_manager_id uuid, p_staff_id uuid)
returns text language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  st public.staff%rowtype;
  v_pin text;
begin
  if p_staff_id = mgr.id then raise exception 'INVALID_INPUT'; end if;
  select * into st from public.staff
   where id = p_staff_id and location = coalesce(mgr.location, 'Hawthorne') for no key update;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  if st.role <> 'staff' and mgr.role <> 'manager' then raise exception 'GM_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('marinara-pin-assignment'));
  v_pin := public.mh_random_free_pin();
  update public.staff
     set pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf', 6)),
         pin_must_change = true, pin_conflict_at = null
   where id = p_staff_id;
  update public.staff_sessions set revoked_at = now() where staff_id = p_staff_id and revoked_at is null;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (p_staff_id, p_staff_id, mgr.id, 'manager_temp_pin', null, jsonb_build_object('pin_changed', true, 'temporary', true));
  return v_pin;
end $$;

create or replace function public.mh_pin_must_change(p_staff_id uuid)
returns boolean language sql stable security definer set search_path to 'public'
as $$ select coalesce((select pin_must_change from public.staff where id = p_staff_id), false) $$;

-- The person changes their own PIN. Rejections are returned (not raised) so
-- they can be counted: after 5 rejections in an hour further tries are refused,
-- so this cannot be used to discover which PINs other people use.
create or replace function public.staff_change_pin(p_staff_id uuid, p_old_pin text, p_new_pin text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare st public.staff%rowtype; v_fails integer;
begin
  perform pg_advisory_xact_lock(hashtext('marinara-pin-assignment'));
  select * into st from public.staff where id = p_staff_id and active = true for no key update;
  if not found then return jsonb_build_object('ok', false, 'code', 'STAFF_NOT_FOUND'); end if;
  select count(*) into v_fails from public.auth_events
   where event = 'pin_change_rejected' and staff_id = st.id and at > now() - interval '1 hour';
  if v_fails >= 5 then return jsonb_build_object('ok', false, 'code', 'TOO_MANY'); end if;
  if p_old_pin is null or p_old_pin !~ '^[0-9]{4,6}$' or st.pin_hash <> extensions.crypt(p_old_pin, st.pin_hash) then
    insert into public.auth_events (event, staff_id, detail) values ('pin_change_rejected', st.id, jsonb_build_object('why', 'old'));
    return jsonb_build_object('ok', false, 'code', 'WRONG_OLD');
  end if;
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'code', 'BAD_FORMAT');
  end if;
  if p_new_pin = p_old_pin or p_new_pin ~ '^(.)\1+$' or p_new_pin in ('1234', '4321', '12345', '123456', '654321', '012345') then
    insert into public.auth_events (event, staff_id, detail) values ('pin_change_rejected', st.id, jsonb_build_object('why', 'weak'));
    return jsonb_build_object('ok', false, 'code', 'TOO_SIMPLE');
  end if;
  if public.mh_pin_in_use(p_new_pin, st.id) then
    insert into public.auth_events (event, staff_id, detail) values ('pin_change_rejected', st.id, jsonb_build_object('why', 'taken'));
    return jsonb_build_object('ok', false, 'code', 'TOO_SIMPLE');
  end if;
  update public.staff
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 6)),
         pin_must_change = false, pin_conflict_at = null
   where id = st.id;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (st.id, st.id, st.id, 'staff_change_pin', null, jsonb_build_object('pin_changed', true));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.mh_random_free_pin() from public, anon, authenticated;
revoke all on function public.manager_staff_temp_pin(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mh_pin_must_change(uuid) from public, anon, authenticated;
revoke all on function public.staff_change_pin(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mh_random_free_pin() to service_role;
grant execute on function public.manager_staff_temp_pin(uuid, uuid) to service_role;
grant execute on function public.mh_pin_must_change(uuid) to service_role;
grant execute on function public.staff_change_pin(uuid, text, text) to service_role;
