-- Multi-unit + admin role. TEST PROJECT ONLY (kskrkzxiaxesvghvvecp).
-- Admin: sees and acts on every unit. Managers (manager / kitchen_manager / floor_manager)
-- stay locked to their own unit, exactly as before.

-- 1. Roles and units
alter table public.staff drop constraint staff_role_check;
alter table public.staff add constraint staff_role_check
  check (role = any (array['staff'::text, 'manager'::text, 'kitchen_manager'::text, 'floor_manager'::text, 'admin'::text]));
alter table public.staff add constraint staff_location_check
  check (location = any (array['Hawthorne'::text, 'Paddington'::text, 'Clayfield'::text]));

-- 2. Helpers
CREATE OR REPLACE FUNCTION public.mh_is_admin(p_role text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$ select p_role = 'admin' $function$
;

-- Can this manager act on staff of this unit? Admin: any unit. Others: own unit only.
CREATE OR REPLACE FUNCTION public.mh_location_ok(p_mgr staff, p_location text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$ select p_mgr.role = 'admin' or p_location is not distinct from coalesce(p_mgr.location, 'Hawthorne') $function$
;

CREATE OR REPLACE FUNCTION public.mh_manager(p_manager_id uuid)
 RETURNS staff
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare mgr public.staff%rowtype;
begin
  select * into mgr from public.staff where id = p_manager_id and active = true;
  if not found or mgr.role not in ('manager', 'kitchen_manager', 'floor_manager', 'admin') then
    raise exception 'MANAGER_REQUIRED';
  end if;
  return mgr;
end $function$
;

CREATE OR REPLACE FUNCTION public.mh_lock_shift(p_mgr staff, p_shift_id uuid, p_require_active boolean)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  sh public.shifts%rowtype;
  st public.staff%rowtype;
  v_scope text := public.mh_scope(p_mgr.role);
begin
  select * into sh from public.shifts where id = p_shift_id;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  select * into st from public.staff where id = sh.staff_id for no key update;
  if not public.mh_location_ok(p_mgr, st.location) then raise exception 'SHIFT_NOT_FOUND'; end if;
  if p_require_active and st.active is not true then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  select * into sh from public.shifts where id = p_shift_id for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  return sh;
end $function$
;

-- 3. Manager actions: same logic as production, only the unit check and the admin role change.
CREATE OR REPLACE FUNCTION public.manager_clock_out_staff(p_manager_id uuid, p_shift_id uuid, p_clock_out timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mgr public.staff%rowtype;
  sh public.shifts%rowtype;
  st public.staff%rowtype;
  v_now timestamptz := now();
  v_scope text;
  v_bad_breaks integer;
  v_closed_break_ids uuid[];
  v_old jsonb;
  v_new jsonb;
  v_note text;
  v_rows integer;
  v_audit_id uuid;
  v_breaks jsonb;
  v_break_seconds numeric;
begin
  if p_manager_id is null or p_shift_id is null or p_clock_out is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into mgr from public.staff where id = p_manager_id and active = true;
  if not found or mgr.role not in ('manager', 'kitchen_manager', 'floor_manager', 'admin') then
    raise exception 'MANAGER_REQUIRED';
  end if;

  v_scope := case mgr.role when 'kitchen_manager' then 'Kitchen' when 'floor_manager' then 'Floor' else null end;

  select * into sh from public.shifts where id = p_shift_id for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;

  select * into st from public.staff where id = sh.staff_id;
  if not found or st.active is not true or not public.mh_location_ok(mgr, st.location) then
    raise exception 'SHIFT_NOT_FOUND';
  end if;

  if v_scope is not null and (st.department is distinct from v_scope or (st.role <> 'staff' and st.id <> mgr.id)) then
    raise exception 'DEPARTMENT_DENIED';
  end if;

  if sh.approved then raise exception 'SHIFT_APPROVED'; end if;
  if sh.clock_out is not null or sh.status not in ('working', 'break') then raise exception 'SHIFT_ALREADY_CLOSED'; end if;
  if p_clock_out <= sh.clock_in then raise exception 'CLOCK_OUT_BEFORE_CLOCK_IN'; end if;
  if p_clock_out > v_now + interval '1 minute' then raise exception 'CLOCK_OUT_IN_FUTURE'; end if;

  perform 1 from public.breaks where shift_id = sh.id for update;

  select count(*) into v_bad_breaks from public.breaks where shift_id = sh.id
    and (break_start >= p_clock_out or (break_end is not null and break_end > p_clock_out));
  if v_bad_breaks > 0 then raise exception 'CLOCK_OUT_BEFORE_BREAK_END'; end if;

  select jsonb_build_object('shift', to_jsonb(sh), 'breaks', coalesce((select jsonb_agg(to_jsonb(b) order by b.break_start) from public.breaks b where b.shift_id = sh.id), '[]'::jsonb)) into v_old;

  with closed as (update public.breaks set break_end = p_clock_out where shift_id = sh.id and break_end is null returning id)
  select coalesce(array_agg(id), '{}') into v_closed_break_ids from closed;

  v_note := 'Clocked out by ' || mgr.name || ' (manager) on ' || to_char(v_now at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || ' Brisbane';

  update public.shifts set clock_out = p_clock_out, status = 'completed', approved = false,
    notes = case when coalesce(btrim(sh.notes), '') = '' then v_note else sh.notes || E'\n' || v_note end
  where id = sh.id and clock_out is null and approved = false;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'SHIFT_ALREADY_CLOSED'; end if;

  select * into sh from public.shifts where id = p_shift_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'break_start', b.break_start, 'break_end', b.break_end) order by b.break_start), '[]'::jsonb),
    coalesce(sum(extract(epoch from (b.break_end - b.break_start))), 0)
  into v_breaks, v_break_seconds from public.breaks b where b.shift_id = sh.id;

  v_new := jsonb_build_object('action', 'manager_clock_out_staff', 'shift', to_jsonb(sh), 'breaks', v_breaks,
    'closed_open_break_ids', to_jsonb(v_closed_break_ids),
    'manager', jsonb_build_object('id', mgr.id, 'name', mgr.name, 'role', mgr.role), 'performed_at', v_now);

  insert into public.shift_audit (shift_id, changed_by, old_data, new_data, changed_at)
  values (sh.id, mgr.id, v_old, v_new, v_now) returning id into v_audit_id;

  return jsonb_build_object('shift_id', sh.id, 'staff_id', st.id, 'name', st.name, 'department', st.department,
    'clock_in', sh.clock_in, 'clock_out', sh.clock_out, 'status', sh.status, 'approved', sh.approved, 'notes', sh.notes,
    'breaks', v_breaks, 'break_minutes', round(v_break_seconds / 60),
    'hours', round(greatest(0, extract(epoch from (sh.clock_out - sh.clock_in)) - v_break_seconds) / 3600, 2),
    'closed_open_breaks', coalesce(array_length(v_closed_break_ids, 1), 0),
    'audit_id', v_audit_id, 'performed_by', mgr.name, 'performed_at', v_now);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.manager_create_shift(p_manager_id uuid, p_staff_id uuid, p_clock_in timestamp with time zone, p_clock_out timestamp with time zone, p_break_minutes integer, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  st public.staff%rowtype;
  v_scope text := public.mh_scope(mgr.role);
  v_id uuid;
  v_break_start timestamptz;
begin
  if p_staff_id is null or p_clock_in is null or p_clock_out is null or p_break_minutes is null then
    raise exception 'INVALID_INPUT';
  end if;
  select * into st from public.staff
   where id = p_staff_id and active = true
   for no key update;
  if not found or not public.mh_location_ok(mgr, st.location) then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  if p_clock_out <= p_clock_in then raise exception 'CLOCK_OUT_BEFORE_CLOCK_IN'; end if;
  if p_break_minutes < 0 or p_break_minutes > 720
     or p_break_minutes >= floor(extract(epoch from (p_clock_out - p_clock_in)) / 60) then
    raise exception 'INVALID_BREAK';
  end if;
  begin
    insert into public.shifts (staff_id, clock_in, clock_out, status, approved, notes)
    values (p_staff_id, p_clock_in, p_clock_out, 'completed', false,
            case when coalesce(btrim(p_notes), '') = '' then '[MANUALLY CREATED]' else '[MANUALLY CREATED] ' || btrim(p_notes) end)
    returning id into v_id;
    if p_break_minutes > 0 then
      v_break_start := p_clock_in + ((p_clock_out - p_clock_in) - make_interval(mins => p_break_minutes)) / 2;
      v_break_start := date_trunc('milliseconds', v_break_start);
      insert into public.breaks (shift_id, break_start, break_end)
      values (v_id, v_break_start, v_break_start + make_interval(mins => p_break_minutes));
    end if;
  exception when exclusion_violation then
    raise exception 'SHIFT_OVERLAP';
  end;
  perform public.mh_shift_audit(v_id, mgr, 'manager_create_shift', null, public.mh_shift_json(v_id));
  return public.mh_shift_json(v_id) || jsonb_build_object('employee', public.mh_staff_json(p_staff_id));
end $function$
;

-- Existing signature kept: creates staff in the manager's own unit (admin: own unit too).
CREATE OR REPLACE FUNCTION public.manager_create_staff_audited(p_manager_id uuid, p_name text, p_pin text, p_department text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return public.manager_create_staff_in_unit(p_manager_id, p_name, p_pin, p_department, null);
end $function$
;

-- New: admin can choose the unit; everyone else is forced to their own unit.
CREATE OR REPLACE FUNCTION public.manager_create_staff_in_unit(p_manager_id uuid, p_name text, p_pin text, p_department text, p_location text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  v_location text := coalesce(mgr.location, 'Hawthorne');
  v_row record;
begin
  if nullif(p_location, '') is not null then
    if not public.mh_location_ok(mgr, p_location) then raise exception 'LOCATION_DENIED'; end if;
    v_location := p_location;
  end if;
  if v_scope is not null and p_department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  perform pg_advisory_xact_lock(hashtext('marinara-pin-assignment'));
  if p_pin ~ '^[0-9]{4,6}$' and public.mh_pin_in_use(p_pin, null) then raise exception 'PIN_IN_USE'; end if;
  select * into v_row from public.manager_create_staff(p_name, p_pin, p_department, v_location);
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (v_row.id, v_row.id, mgr.id, 'manager_create_staff', null, public.mh_staff_json(v_row.id));
  return to_jsonb(v_row);
end $function$
;

CREATE OR REPLACE FUNCTION public.manager_update_staff_audited(p_manager_id uuid, p_staff_id uuid, p_name text, p_department text, p_new_pin text, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  st public.staff%rowtype;
  v_old jsonb;
  v_pin_changed boolean := coalesce(p_new_pin, '') <> '';
  -- Only the General Manager (or admin) can change roles; others' role field is ignored.
  v_role text := case when mgr.role in ('manager', 'admin') then nullif(p_role, '') else null end;
begin
  select * into st from public.staff where id = p_staff_id for no key update;
  if not found or not public.mh_location_ok(mgr, st.location) then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_scope is not null and (st.department is distinct from v_scope or p_department is distinct from v_scope) then
    raise exception 'DEPARTMENT_DENIED';
  end if;
  if st.role <> 'staff' and mgr.role not in ('manager', 'admin') then raise exception 'GM_REQUIRED'; end if;
  -- Only an admin can touch an admin account or give the admin role.
  if (st.role = 'admin' or v_role = 'admin') and mgr.role <> 'admin' then raise exception 'ADMIN_REQUIRED'; end if;
  if v_role is not null and v_role not in ('staff', 'manager', 'kitchen_manager', 'floor_manager', 'admin') then
    raise exception 'INVALID_ROLE';
  end if;
  if v_pin_changed then
    perform pg_advisory_xact_lock(hashtext('marinara-pin-assignment'));
    if p_new_pin ~ '^[0-9]{4,6}$' and public.mh_pin_in_use(p_new_pin, p_staff_id) then raise exception 'PIN_IN_USE'; end if;
  end if;
  v_old := public.mh_staff_json(p_staff_id);
  perform public.manager_update_staff(p_staff_id, p_name, p_department, nullif(p_new_pin, ''));
  if v_role is not null and v_role <> st.role then
    update public.staff set role = v_role where id = p_staff_id;
  end if;
  if v_pin_changed then
    update public.staff set pin_conflict_at = null where id = p_staff_id;
  end if;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (p_staff_id, p_staff_id, mgr.id, 'manager_update_staff', v_old,
          public.mh_staff_json(p_staff_id) || jsonb_build_object('pin_changed', v_pin_changed));
  return public.mh_staff_json(p_staff_id)
    || jsonb_build_object('created_at', (select created_at from public.staff where id = p_staff_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.manager_toggle_staff_audited(p_manager_id uuid, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  st public.staff%rowtype;
  v_old jsonb;
begin
  select * into st from public.staff where id = p_staff_id for no key update;
  if not found or not public.mh_location_ok(mgr, st.location) then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  if st.role <> 'staff' and mgr.role not in ('manager', 'admin') then raise exception 'GM_REQUIRED'; end if;
  if st.role = 'admin' and mgr.role <> 'admin' then raise exception 'ADMIN_REQUIRED'; end if;
  if st.id = mgr.id then raise exception 'CANNOT_DEACTIVATE_SELF'; end if;
  v_old := public.mh_staff_json(p_staff_id);
  update public.staff set active = not st.active where id = p_staff_id;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (p_staff_id, p_staff_id, mgr.id, case when st.active then 'manager_deactivate_staff' else 'manager_activate_staff' end,
          v_old, public.mh_staff_json(p_staff_id));
  return public.mh_staff_json(p_staff_id)
    || jsonb_build_object('created_at', (select created_at from public.staff where id = p_staff_id));
end $function$
;

-- 4. Privileges: same pattern as production (only the server, via service_role).
revoke all on function public.mh_is_admin(text), public.mh_location_ok(staff, text),
  public.manager_create_staff_in_unit(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.manager_create_staff_in_unit(uuid, text, text, text, text) to service_role;
