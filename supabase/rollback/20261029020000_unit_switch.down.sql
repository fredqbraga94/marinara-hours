-- Rollback of 20261029020000_unit_switch.sql: everyone back to their own unit;
-- mh_manager and the four functions as before.
create or replace function public.mh_manager(p_manager_id uuid)
returns public.staff
language plpgsql stable security definer set search_path to 'public'
as $$
declare mgr public.staff%rowtype;
begin
  select * into mgr from public.staff where id = p_manager_id and active = true;
  if not found or mgr.role not in ('manager', 'kitchen_manager', 'floor_manager') then
    raise exception 'MANAGER_REQUIRED';
  end if;
  return mgr;
end $$;

create or replace function public.manager_clock_out_staff(
  p_manager_id uuid,
  p_shift_id uuid,
  p_clock_out timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Manager must be an active manager account.
  select * into mgr
  from public.staff
  where id = p_manager_id and active = true;

  if not found or mgr.role not in ('manager', 'kitchen_manager', 'floor_manager') then
    raise exception 'MANAGER_REQUIRED';
  end if;

  v_scope := case mgr.role
    when 'kitchen_manager' then 'Kitchen'
    when 'floor_manager' then 'Floor'
    else null
  end;

  -- Lock the shift row: concurrent clock-outs / staff actions wait here.
  select * into sh
  from public.shifts
  where id = p_shift_id
  for update;

  if not found then
    raise exception 'SHIFT_NOT_FOUND';
  end if;

  select * into st
  from public.staff
  where id = sh.staff_id;

  if not found
     or st.active is not true
     or st.location is distinct from coalesce(mgr.location, 'Hawthorne') then
    raise exception 'SHIFT_NOT_FOUND';
  end if;

  -- Department scope (same rule as the manager team view):
  -- scoped managers only act on staff of their department (or themselves).
  if v_scope is not null
     and (st.department is distinct from v_scope
          or (st.role <> 'staff' and st.id <> mgr.id)) then
    raise exception 'DEPARTMENT_DENIED';
  end if;

  if sh.approved then
    raise exception 'SHIFT_APPROVED';
  end if;

  if sh.clock_out is not null or sh.status not in ('working', 'break') then
    raise exception 'SHIFT_ALREADY_CLOSED';
  end if;

  if p_clock_out <= sh.clock_in then
    raise exception 'CLOCK_OUT_BEFORE_CLOCK_IN';
  end if;

  -- 1 minute tolerance for device clock drift.
  if p_clock_out > v_now + interval '1 minute' then
    raise exception 'CLOCK_OUT_IN_FUTURE';
  end if;

  -- Lock the shift's breaks too.
  perform 1 from public.breaks where shift_id = sh.id for update;

  -- Clock out cannot fall inside or before a recorded break.
  select count(*) into v_bad_breaks
  from public.breaks
  where shift_id = sh.id
    and (
      break_start >= p_clock_out
      or (break_end is not null and break_end > p_clock_out)
    );

  if v_bad_breaks > 0 then
    raise exception 'CLOCK_OUT_BEFORE_BREAK_END';
  end if;

  select jsonb_build_object(
    'shift', to_jsonb(sh),
    'breaks', coalesce(
      (select jsonb_agg(to_jsonb(b) order by b.break_start)
       from public.breaks b where b.shift_id = sh.id),
      '[]'::jsonb)
  ) into v_old;

  -- A break still open ends at the clock-out time.
  with closed as (
    update public.breaks
    set break_end = p_clock_out
    where shift_id = sh.id and break_end is null
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_closed_break_ids from closed;

  v_note := 'Clocked out by ' || mgr.name || ' (manager) on '
    || to_char(v_now at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI')
    || ' Brisbane';

  update public.shifts
  set
    clock_out = p_clock_out,
    status = 'completed',
    approved = false,
    notes = case
      when coalesce(btrim(sh.notes), '') = '' then v_note
      else sh.notes || E'\n' || v_note
    end
  where id = sh.id
    and clock_out is null
    and approved = false;

  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception 'SHIFT_ALREADY_CLOSED';
  end if;

  select * into sh from public.shifts where id = p_shift_id;

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', b.id, 'break_start', b.break_start, 'break_end', b.break_end)
      order by b.break_start),
    '[]'::jsonb),
    coalesce(sum(extract(epoch from (b.break_end - b.break_start))), 0)
  into v_breaks, v_break_seconds
  from public.breaks b
  where b.shift_id = sh.id;

  v_new := jsonb_build_object(
    'action', 'manager_clock_out_staff',
    'shift', to_jsonb(sh),
    'breaks', v_breaks,
    'closed_open_break_ids', to_jsonb(v_closed_break_ids),
    'manager', jsonb_build_object('id', mgr.id, 'name', mgr.name, 'role', mgr.role),
    'performed_at', v_now
  );

  insert into public.shift_audit (shift_id, changed_by, old_data, new_data, changed_at)
  values (sh.id, mgr.id, v_old, v_new, v_now)
  returning id into v_audit_id;

  return jsonb_build_object(
    'shift_id', sh.id,
    'staff_id', st.id,
    'name', st.name,
    'department', st.department,
    'clock_in', sh.clock_in,
    'clock_out', sh.clock_out,
    'status', sh.status,
    'approved', sh.approved,
    'notes', sh.notes,
    'breaks', v_breaks,
    'break_minutes', round(v_break_seconds / 60),
    'hours', round(greatest(0, extract(epoch from (sh.clock_out - sh.clock_in)) - v_break_seconds) / 3600, 2),
    'closed_open_breaks', coalesce(array_length(v_closed_break_ids, 1), 0),
    'audit_id', v_audit_id,
    'performed_by', mgr.name,
    'performed_at', v_now
  );
end;
$function$;

create or replace function public.manager_permissions_list(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_admin public.staff%rowtype;
begin
  select * into v_admin from public.staff where id = p_manager_id and active and role = 'manager';
  if not found then raise exception 'GM_REQUIRED'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'staff_id', s.id,
             'custom', p.staff_id is not null,
             'hours', coalesce(p.hours, true), 'team', coalesce(p.team, true),
             'roster', coalesce(p.roster, true), 'time_off', coalesce(p.time_off, true),
             'stock', coalesce(p.stock, true), 'recipes', coalesce(p.recipes, true),
             'invoices', coalesce(p.invoices, true)))
      from public.staff s
      left join public.manager_permissions p on p.staff_id = s.id
     where s.location = v_admin.location and s.role in ('kitchen_manager', 'floor_manager')
  ), '[]'::jsonb);
end $function$;

create or replace function public.manager_permissions_set(p_manager_id uuid, p_staff_id uuid, p_perms jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin public.staff%rowtype;
  v_target public.staff%rowtype;
  v_old public.manager_permissions%rowtype;
  v_new public.manager_permissions%rowtype;
  v_key text;
begin
  select * into v_admin from public.staff where id = p_manager_id and active and role = 'manager';
  if not found then raise exception 'GM_REQUIRED'; end if;
  select * into v_target from public.staff where id = p_staff_id and location = v_admin.location;
  if not found or v_target.role not in ('kitchen_manager', 'floor_manager') then
    raise exception 'NOT_A_MANAGER';
  end if;
  if p_perms is null or jsonb_typeof(p_perms) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  for v_key in select jsonb_object_keys(p_perms) loop
    if v_key not in ('hours', 'team', 'roster', 'time_off', 'stock', 'recipes', 'invoices')
       or jsonb_typeof(p_perms -> v_key) <> 'boolean' then
      raise exception 'INVALID_INPUT';
    end if;
  end loop;

  select * into v_old from public.manager_permissions where staff_id = p_staff_id;
  insert into public.manager_permissions as m (staff_id, hours, team, roster, time_off, stock, recipes, invoices, updated_by, updated_at)
  values (p_staff_id,
          coalesce((p_perms->>'hours')::boolean, v_old.hours, true),
          coalesce((p_perms->>'team')::boolean, v_old.team, true),
          coalesce((p_perms->>'roster')::boolean, v_old.roster, true),
          coalesce((p_perms->>'time_off')::boolean, v_old.time_off, true),
          coalesce((p_perms->>'stock')::boolean, v_old.stock, true),
          coalesce((p_perms->>'recipes')::boolean, v_old.recipes, true),
          coalesce((p_perms->>'invoices')::boolean, v_old.invoices, true),
          p_manager_id, now())
  on conflict (staff_id) do update set
    hours = excluded.hours, team = excluded.team, roster = excluded.roster, time_off = excluded.time_off,
    stock = excluded.stock, recipes = excluded.recipes, invoices = excluded.invoices,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into v_new;

  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (p_staff_id, p_staff_id, p_manager_id, 'permissions',
          case when v_old.staff_id is null then null else to_jsonb(v_old) - 'updated_by' - 'updated_at' end,
          to_jsonb(v_new) - 'updated_by' - 'updated_at');

  return to_jsonb(v_new) - 'updated_by';
end $function$;

create or replace function public.manager_push_subscribe(
  p_manager_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_row public.push_subscriptions%rowtype;
begin
  if p_endpoint is null or p_p256dh is null or p_auth is null then raise exception 'INVALID_INPUT'; end if;
  insert into public.push_subscriptions (staff_id, location, endpoint, p256dh, auth, device_label)
  values (mgr.id, coalesce(mgr.location, 'Hawthorne'), p_endpoint, p_p256dh, p_auth,
          nullif(left(trim(coalesce(p_label, '')), 80), ''))
  on conflict (endpoint) do update
    set staff_id = excluded.staff_id, location = excluded.location,
        p256dh = excluded.p256dh, auth = excluded.auth,
        device_label = coalesce(excluded.device_label, public.push_subscriptions.device_label),
        active = true, failures = 0, last_error = null, updated_at = now()
  returning * into v_row;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (mgr.id, mgr.id, mgr.id, 'manager_push_subscribe', null,
          jsonb_build_object('subscription', v_row.id, 'device_label', v_row.device_label));
  return public.mh_push_json(v_row);
exception
  when check_violation then raise exception 'INVALID_INPUT';
end $function$;

drop function if exists public.manager_unit_set(uuid, text);
drop function if exists public.manager_units(uuid);
drop function if exists public.mh_unit_of(uuid);
drop function if exists public.mh_units();
drop table if exists public.manager_unit_view;
