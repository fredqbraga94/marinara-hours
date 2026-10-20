-- Roster roles and roster-only people.
-- Additive only: two new staff columns with safe defaults, one new table and
-- new audited functions. No existing row, function, policy or grant changes,
-- so the running app keeps working unchanged with this migration in place.
--
-- position    : what the person does, for the roster: Kitchen = Chef or
--               Dishwasher, Floor = Floor or Bar (empty = not set yet)
-- roster_only : on salary (full or part time): shows on the roster and time
--               off, but has no PIN, does not use the time clock and never
--               appears in hours, approvals or timesheets.

alter table public.staff
  add column if not exists position text
    check (position is null or position in ('Chef', 'Dishwasher', 'Floor', 'Bar')),
  add column if not exists roster_only boolean not null default false;

-- Usual service times per role (overrides the department times in
-- roster_services). Agreed with the owner 2026-10-20: chef lunch 10:30-15:00,
-- dinner from 16:30; dishwasher lunch 11:00-15:00, dinner from 17:00 until
-- after the 21:30 close (planned to 22:30).
create table if not exists public.roster_position_services (
  location text not null,
  position text not null check (position in ('Chef', 'Dishwasher', 'Floor', 'Bar')),
  service text not null check (service in ('L', 'D')),
  start_time time not null,
  end_time time not null,
  updated_at timestamptz not null default now(),
  primary key (location, position, service)
);
alter table public.roster_position_services enable row level security;
revoke all on public.roster_position_services from anon, authenticated;
-- The server reads this table directly (as it does public_holidays).
grant select on public.roster_position_services to service_role;

insert into public.roster_position_services (location, position, service, start_time, end_time)
select u.location, v.position, v.service, v.start_time, v.end_time
  from (values ('Hawthorne'), ('Paddington'), ('Clayfield')) u(location),
       (values ('Chef', 'L', time '10:30', time '15:00'),
               ('Chef', 'D', time '16:30', time '22:30'),
               ('Dishwasher', 'L', time '11:00', time '15:00'),
               ('Dishwasher', 'D', time '17:00', time '22:30')) v(position, service, start_time, end_time)
on conflict (location, position, service) do nothing;

create or replace function public.mh_position_ok(p_department text, p_position text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select p_position is null
      or (p_department = 'Kitchen' and p_position in ('Chef', 'Dishwasher'))
      or (p_department = 'Floor' and p_position in ('Floor', 'Bar'))
$function$;

-- Set a person's roster role and whether they are roster-only.
-- Making someone roster-only replaces their PIN with an unusable secret, so
-- they can no longer sign in. To bring them back to the time clock, give them
-- a new PIN (Edit) and untick roster-only.
create or replace function public.manager_set_roster_info_audited(
  p_manager_id uuid,
  p_staff_id uuid,
  p_position text,
  p_roster_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  st public.staff%rowtype;
  v_pos text := nullif(trim(coalesce(p_position, '')), '');
  v_only boolean := coalesce(p_roster_only, false);
  v_old jsonb;
begin
  select * into st from public.staff where id = p_staff_id for no key update;
  if not found or (st.location is distinct from mgr.location and mgr.role <> 'admin') then
    raise exception 'STAFF_NOT_FOUND';
  end if;
  if v_scope is not null and st.department is distinct from v_scope then
    raise exception 'DEPARTMENT_DENIED';
  end if;
  if not public.mh_position_ok(st.department, v_pos) then raise exception 'INVALID_INPUT'; end if;
  -- Manager accounts always keep the time clock.
  if v_only and st.role <> 'staff' then raise exception 'INVALID_ROLE'; end if;

  v_old := public.mh_staff_json(p_staff_id)
    || jsonb_build_object('position', st.position, 'roster_only', st.roster_only);

  update public.staff
     set position = v_pos,
         roster_only = v_only,
         pin_hash = case when v_only and not st.roster_only
                         then extensions.crypt(encode(extensions.gen_random_bytes(24), 'base64'), extensions.gen_salt('bf', 6))
                         else pin_hash end,
         pin_conflict_at = case when v_only then null else pin_conflict_at end
   where id = p_staff_id;

  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  select p_staff_id, p_staff_id, mgr.id, 'manager_set_roster_info', v_old,
         public.mh_staff_json(p_staff_id) || jsonb_build_object('position', s.position, 'roster_only', s.roster_only)
    from public.staff s where s.id = p_staff_id;

  return (select jsonb_build_object('id', s.id, 'position', s.position, 'roster_only', s.roster_only)
            from public.staff s where s.id = p_staff_id);
end $function$;

-- Add a roster-only person (no PIN, no time clock).
create or replace function public.manager_create_roster_person_audited(
  p_manager_id uuid,
  p_name text,
  p_department text,
  p_position text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_dep text := coalesce(v_scope, nullif(trim(coalesce(p_department, '')), ''));
  v_pos text := nullif(trim(coalesce(p_position, '')), '');
  v_id uuid;
begin
  if v_name is null or length(v_name) > 80 or v_dep not in ('Kitchen', 'Floor') then raise exception 'INVALID_INPUT'; end if;
  if v_scope is not null and p_department is not null and p_department <> v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  if not public.mh_position_ok(v_dep, v_pos) then raise exception 'INVALID_INPUT'; end if;

  insert into public.staff (name, pin_hash, department, location, role, active, position, roster_only)
  values (v_name,
          extensions.crypt(encode(extensions.gen_random_bytes(24), 'base64'), extensions.gen_salt('bf', 6)),
          v_dep, coalesce(mgr.location, 'Hawthorne'), 'staff', true, v_pos, true)
  returning id into v_id;

  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (v_id, v_id, mgr.id, 'manager_create_staff', null,
          public.mh_staff_json(v_id) || jsonb_build_object('position', v_pos, 'roster_only', true));

  return public.mh_staff_json(v_id) || jsonb_build_object('position', v_pos, 'roster_only', true);
end $function$;

revoke all on function public.mh_position_ok(text, text) from public, anon, authenticated;
revoke all on function public.manager_set_roster_info_audited(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.manager_create_roster_person_audited(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.manager_set_roster_info_audited(uuid, uuid, text, boolean) to service_role;
grant execute on function public.manager_create_roster_person_audited(uuid, text, text, text) to service_role;
