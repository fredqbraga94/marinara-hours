-- Marinara Hours — integrity, audit and least privilege (replaces draft PR #4).
--
-- Compatible with the Edge Function in production (v37) and with v38.
-- Non-destructive: no existing row is changed or deleted.
--
-- 1. Pre-checks: the migration aborts (and rolls back) if existing data would
--    violate the new rules. Production was checked read-only on 2026-10-13: 0 violations.
-- 2. Database guarantees, independent of the application code:
--    - a person can never have two shifts that overlap in time;
--    - a shift can never have two breaks that overlap, nor two open breaks;
--    - clock out / break end can never be before clock in / break start.
-- 3. Staff clock functions (clock in, breaks, clock out) serialise per person
--    (row lock), so a double tap or two devices cannot interleave.
--    Return values and error codes are unchanged.
-- 4. Manager changes run as single-transaction functions that also write an
--    audit record. Deleting a shift no longer deletes its audit history.
-- 5. API roles lose privileges they never need.
--
-- Rollback: supabase/rollback/20261013010000_integrity_audit_privileges.down.sql

-- ---------------------------------------------------------------- 1. pre-checks
do $precheck$
declare
  n integer;
begin
  select count(*) into n
  from public.shifts a
  join public.shifts b on a.staff_id = b.staff_id and a.id < b.id
   and tstzrange(a.clock_in, coalesce(a.clock_out, 'infinity'::timestamptz), '[)')
    && tstzrange(b.clock_in, coalesce(b.clock_out, 'infinity'::timestamptz), '[)');
  if n > 0 then raise exception 'PRECHECK_FAILED: % overlapping shift pair(s)', n; end if;

  select count(*) into n
  from public.breaks a
  join public.breaks b on a.shift_id = b.shift_id and a.id < b.id
   and tstzrange(a.break_start, coalesce(a.break_end, 'infinity'::timestamptz), '[)')
    && tstzrange(b.break_start, coalesce(b.break_end, 'infinity'::timestamptz), '[)');
  if n > 0 then raise exception 'PRECHECK_FAILED: % overlapping break pair(s)', n; end if;

  select count(*) into n from public.shifts where clock_out is not null and clock_out < clock_in;
  if n > 0 then raise exception 'PRECHECK_FAILED: % shift(s) end before they start', n; end if;

  select count(*) into n from public.breaks where break_end is not null and break_end < break_start;
  if n > 0 then raise exception 'PRECHECK_FAILED: % break(s) end before they start', n; end if;
end
$precheck$;

-- ---------------------------------------------------------------- 2. database guarantees
create extension if not exists btree_gist with schema extensions;

alter table public.shifts
  add constraint shifts_clock_out_not_before_in
  check (clock_out is null or clock_out >= clock_in);

alter table public.breaks
  add constraint breaks_end_not_before_start
  check (break_end is null or break_end >= break_start);

alter table public.shifts
  add constraint shifts_no_overlap_per_staff
  exclude using gist (
    staff_id with =,
    tstzrange(clock_in, coalesce(clock_out, 'infinity'::timestamptz), '[)') with &&
  );

alter table public.breaks
  add constraint breaks_no_overlap_per_shift
  exclude using gist (
    shift_id with =,
    tstzrange(break_start, coalesce(break_end, 'infinity'::timestamptz), '[)') with &&
  );

create unique index if not exists breaks_one_open_per_shift_uidx
  on public.breaks (shift_id)
  where break_end is null;

-- ---------------------------------------------------------------- 4a. audit history
-- Deleting a shift keeps its audit rows (shift_id becomes null, shift_ref keeps the id).
alter table public.shift_audit drop constraint if exists shift_audit_shift_id_fkey;
alter table public.shift_audit
  add constraint shift_audit_shift_id_fkey
  foreign key (shift_id) references public.shifts(id) on delete set null;
alter table public.shift_audit add column if not exists action text;
alter table public.shift_audit add column if not exists shift_ref uuid;
update public.shift_audit set shift_ref = shift_id where shift_ref is null and shift_id is not null;
create index if not exists shift_audit_shift_ref_idx on public.shift_audit (shift_ref);

-- Staff changes made by managers (create, edit, PIN reset, activate/deactivate).
-- Never stores PIN hashes.
create table if not exists public.staff_audit (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references public.staff(id) on delete set null,
  staff_ref uuid not null,
  changed_by uuid references public.staff(id),
  action text not null,
  old_data jsonb,
  new_data jsonb,
  changed_at timestamptz not null default now()
);
alter table public.staff_audit enable row level security;
create index if not exists staff_audit_staff_ref_idx on public.staff_audit (staff_ref);

-- Marks staff whose PIN was found to be shared by more than one person (set by v38 at login).
alter table public.staff add column if not exists pin_conflict_at timestamptz;

-- ---------------------------------------------------------------- 3. staff clock functions
-- Same logic, return values and error codes as production; each now locks the
-- person's staff row first and then the shift row, so concurrent actions for one
-- person (double taps, two devices, a manager acting at the same time) run one at
-- a time and re-check the shift state after waiting.

CREATE OR REPLACE FUNCTION public.clock_in_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sh public.shifts%rowtype;
begin
  perform 1 from public.staff where id = p_staff_id and active = true for no key update;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
  if exists(select 1 from public.shifts where staff_id=p_staff_id and status in ('working','break')) then raise exception 'SHIFT_ALREADY_OPEN'; end if;
  insert into public.shifts(staff_id, clock_in, status) values(p_staff_id, now(), 'working') returning * into sh;
  return public.staff_status_by_id(p_staff_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.start_break_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sh public.shifts%rowtype;
begin
  perform 1 from public.staff where id = p_staff_id for no key update;
  select * into sh from public.shifts where staff_id=p_staff_id and status='working' order by clock_in desc limit 1 for update;
  if not found then raise exception 'NO_WORKING_SHIFT'; end if;
  insert into public.breaks(shift_id, break_start) values(sh.id, now());
  update public.shifts set status='break' where id=sh.id;
  return public.staff_status_by_id(p_staff_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.end_break_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sh public.shifts%rowtype; br public.breaks%rowtype;
begin
  perform 1 from public.staff where id = p_staff_id for no key update;
  select * into sh from public.shifts where staff_id=p_staff_id and status='break' order by clock_in desc limit 1 for update;
  if not found then raise exception 'NO_ACTIVE_BREAK'; end if;
  select * into br from public.breaks where shift_id=sh.id and break_end is null order by break_start desc limit 1 for update;
  if not found then raise exception 'NO_ACTIVE_BREAK'; end if;
  update public.breaks set break_end=now() where id=br.id;
  update public.shifts set status='working' where id=sh.id;
  return public.staff_status_by_id(p_staff_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.clock_out_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  sh public.shifts%rowtype;
begin
  perform 1 from public.staff where id = p_staff_id for no key update;

  select *
  into sh
  from public.shifts
  where staff_id = p_staff_id
    and status in ('working','break')
  order by clock_in desc
  limit 1
  for update;

  if not found then
    raise exception 'NO_OPEN_SHIFT';
  end if;

  if sh.status = 'break' then
    raise exception 'END_BREAK_REQUIRED';
  end if;

  update public.shifts
  set
    clock_out = now(),
    status = 'completed'
  where id = sh.id;

  return public.staff_status_by_id(p_staff_id);
end;
$function$;

-- ---------------------------------------------------------------- 4b. manager functions
-- Shared helpers (internal; not callable by API roles).

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

create or replace function public.mh_scope(p_role text)
returns text language sql immutable set search_path to 'public'
as $$ select case p_role when 'kitchen_manager' then 'Kitchen' when 'floor_manager' then 'Floor' else null end $$;

create or replace function public.mh_shift_json(p_shift_id uuid)
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  select jsonb_build_object(
    'shift', to_jsonb(s),
    'breaks', coalesce((select jsonb_agg(to_jsonb(b) order by b.break_start) from public.breaks b where b.shift_id = s.id), '[]'::jsonb))
  from public.shifts s where s.id = p_shift_id
$$;

create or replace function public.mh_staff_json(p_staff_id uuid)
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'department', s.department, 'location', s.location,
                            'role', s.role, 'active', s.active, 'pin_conflict_at', s.pin_conflict_at)
  from public.staff s where s.id = p_staff_id
$$;

create or replace function public.mh_shift_audit(p_shift_id uuid, p_manager public.staff, p_action text, p_old jsonb, p_new jsonb)
returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare v_id uuid;
begin
  insert into public.shift_audit (shift_id, shift_ref, changed_by, action, old_data, new_data, changed_at)
  values (p_shift_id, p_shift_id, p_manager.id, p_action, p_old,
          coalesce(p_new, '{}'::jsonb) || jsonb_build_object('action', p_action,
            'manager', jsonb_build_object('id', p_manager.id, 'name', p_manager.name, 'role', p_manager.role),
            'performed_at', now()),
          now())
  returning id into v_id;
  return v_id;
end $$;

-- Loads a shift for a manager action with the same visibility rules as v37:
-- same location, department scope for Kitchen/Floor managers; locks the
-- person's staff row and the shift row.
create or replace function public.mh_lock_shift(p_mgr public.staff, p_shift_id uuid, p_require_active boolean)
returns public.shifts
language plpgsql security definer set search_path to 'public'
as $$
declare
  sh public.shifts%rowtype;
  st public.staff%rowtype;
  v_scope text := public.mh_scope(p_mgr.role);
begin
  select * into sh from public.shifts where id = p_shift_id;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  select * into st from public.staff where id = sh.staff_id for no key update;
  if st.location is distinct from coalesce(p_mgr.location, 'Hawthorne') then raise exception 'SHIFT_NOT_FOUND'; end if;
  if p_require_active and st.active is not true then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  select * into sh from public.shifts where id = p_shift_id for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  return sh;
end $$;

-- Edit a closed, unapproved shift: times and one break ending at clock out
-- (same convention as v37), atomically, with audit.
create or replace function public.manager_edit_shift(
  p_manager_id uuid, p_shift_id uuid, p_clock_in timestamptz, p_clock_out timestamptz, p_break_minutes integer)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  sh public.shifts%rowtype;
  v_old jsonb;
begin
  if p_shift_id is null or p_clock_in is null or p_clock_out is null or p_break_minutes is null then
    raise exception 'INVALID_INPUT';
  end if;
  sh := public.mh_lock_shift(mgr, p_shift_id, true);
  if sh.clock_out is null then raise exception 'SHIFT_STILL_OPEN'; end if;
  if sh.approved then raise exception 'SHIFT_APPROVED'; end if;
  if p_clock_out <= p_clock_in then raise exception 'CLOCK_OUT_BEFORE_CLOCK_IN'; end if;
  if p_break_minutes < 0 or p_break_minutes > 720
     or make_interval(mins => p_break_minutes) >= (p_clock_out - p_clock_in) then
    raise exception 'INVALID_BREAK';
  end if;

  v_old := public.mh_shift_json(sh.id);
  begin
    update public.shifts set clock_in = p_clock_in, clock_out = p_clock_out, status = 'completed' where id = sh.id;
    delete from public.breaks where shift_id = sh.id;
    if p_break_minutes > 0 then
      insert into public.breaks (shift_id, break_start, break_end)
      values (sh.id, p_clock_out - make_interval(mins => p_break_minutes), p_clock_out);
    end if;
  exception when exclusion_violation then
    raise exception 'SHIFT_OVERLAP';
  end;
  perform public.mh_shift_audit(sh.id, mgr, 'manager_edit_shift', v_old, public.mh_shift_json(sh.id));
  return public.mh_shift_json(sh.id);
end $$;

-- Create a completed shift by hand; the break sits in the middle (same as v37).
create or replace function public.manager_create_shift(
  p_manager_id uuid, p_staff_id uuid, p_clock_in timestamptz, p_clock_out timestamptz,
  p_break_minutes integer, p_notes text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
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
   where id = p_staff_id and location = coalesce(mgr.location, 'Hawthorne') and active = true
   for no key update;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
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
end $$;

-- Delete a closed, unapproved shift. The audit keeps the full deleted data.
create or replace function public.manager_delete_shift(p_manager_id uuid, p_shift_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  sh public.shifts%rowtype;
  v_old jsonb;
begin
  sh := public.mh_lock_shift(mgr, p_shift_id, false);
  if sh.clock_out is null then raise exception 'SHIFT_STILL_OPEN'; end if;
  if sh.approved then raise exception 'SHIFT_APPROVED'; end if;
  v_old := public.mh_shift_json(sh.id);
  perform public.mh_shift_audit(sh.id, mgr, 'manager_delete_shift', v_old, jsonb_build_object('deleted', true));
  delete from public.shifts where id = sh.id;
  return jsonb_build_object('deleted', true, 'shift_id', sh.id);
end $$;

-- Approve / reopen. No change -> no audit row (same responses as v37).
create or replace function public.manager_set_shift_approved(p_manager_id uuid, p_shift_id uuid, p_approved boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  sh public.shifts%rowtype;
  v_old jsonb;
  v_changed boolean;
begin
  if p_approved is null then raise exception 'INVALID_INPUT'; end if;
  sh := public.mh_lock_shift(mgr, p_shift_id, true);
  if sh.clock_out is null then raise exception 'SHIFT_STILL_OPEN'; end if;
  v_changed := sh.approved is distinct from p_approved;
  if v_changed then
    v_old := public.mh_shift_json(sh.id);
    update public.shifts set approved = p_approved where id = sh.id;
    perform public.mh_shift_audit(sh.id, mgr,
      case when p_approved then 'manager_approve_shift' else 'manager_reopen_shift' end,
      v_old, public.mh_shift_json(sh.id));
  end if;
  return public.mh_shift_json(sh.id) || jsonb_build_object('changed', v_changed);
end $$;

-- Staff management with audit and PIN uniqueness. The production functions
-- manager_create_staff / manager_update_staff are reused unchanged.
create or replace function public.mh_pin_in_use(p_pin text, p_except uuid)
returns boolean language sql stable security definer set search_path to 'public', 'extensions'
as $$
  select exists (
    select 1 from public.staff s
    where s.active = true and s.id is distinct from p_except
      and s.pin_hash = extensions.crypt(p_pin, s.pin_hash))
$$;

create or replace function public.manager_create_staff_audited(
  p_manager_id uuid, p_name text, p_pin text, p_department text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  v_row record;
begin
  if v_scope is not null and p_department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  -- One staff creation / PIN change at a time, so two managers cannot give the same PIN concurrently.
  perform pg_advisory_xact_lock(hashtext('marinara-pin-assignment'));
  if p_pin ~ '^[0-9]{4,6}$' and public.mh_pin_in_use(p_pin, null) then raise exception 'PIN_IN_USE'; end if;
  select * into v_row from public.manager_create_staff(p_name, p_pin, p_department, coalesce(mgr.location, 'Hawthorne'));
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (v_row.id, v_row.id, mgr.id, 'manager_create_staff', null, public.mh_staff_json(v_row.id));
  return to_jsonb(v_row);
end $$;

create or replace function public.manager_update_staff_audited(
  p_manager_id uuid, p_staff_id uuid, p_name text, p_department text, p_new_pin text, p_role text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  st public.staff%rowtype;
  v_old jsonb;
  v_pin_changed boolean := coalesce(p_new_pin, '') <> '';
  -- As in v37: only the General Manager can change roles; others' role field is ignored.
  v_role text := case when mgr.role = 'manager' then nullif(p_role, '') else null end;
begin
  select * into st from public.staff where id = p_staff_id and location = coalesce(mgr.location, 'Hawthorne') for no key update;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_scope is not null and (st.department is distinct from v_scope or p_department is distinct from v_scope) then
    raise exception 'DEPARTMENT_DENIED';
  end if;
  if st.role <> 'staff' and mgr.role <> 'manager' then raise exception 'GM_REQUIRED'; end if;
  if v_role is not null and v_role not in ('staff', 'manager', 'kitchen_manager', 'floor_manager') then
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
end $$;

create or replace function public.manager_toggle_staff_audited(p_manager_id uuid, p_staff_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  st public.staff%rowtype;
  v_old jsonb;
begin
  select * into st from public.staff where id = p_staff_id and location = coalesce(mgr.location, 'Hawthorne') for no key update;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  if st.role <> 'staff' and mgr.role <> 'manager' then raise exception 'GM_REQUIRED'; end if;
  if st.id = mgr.id then raise exception 'CANNOT_DEACTIVATE_SELF'; end if;
  v_old := public.mh_staff_json(p_staff_id);
  update public.staff set active = not st.active where id = p_staff_id;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (p_staff_id, p_staff_id, mgr.id, case when st.active then 'manager_deactivate_staff' else 'manager_activate_staff' end,
          v_old, public.mh_staff_json(p_staff_id));
  return public.mh_staff_json(p_staff_id)
    || jsonb_build_object('created_at', (select created_at from public.staff where id = p_staff_id));
end $$;

-- ---------------------------------------------------------------- 5. least privilege
-- New functions: callable only by the Edge Function (service_role).
do $grants$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('mh_manager', 'mh_scope', 'mh_shift_json', 'mh_staff_json', 'mh_shift_audit', 'mh_lock_shift',
                        'mh_pin_in_use', 'manager_edit_shift', 'manager_create_shift', 'manager_delete_shift',
                        'manager_set_shift_approved', 'manager_create_staff_audited', 'manager_update_staff_audited',
                        'manager_toggle_staff_audited')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.sig::text not like 'mh_%' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end
$grants$;

-- Browser roles never touch tables directly (everything goes through the Edge Function).
revoke all on all tables in schema public from anon, authenticated;
-- The Edge Function never needs TRUNCATE / REFERENCES / TRIGGER (TRUNCATE ignores RLS).
revoke truncate, references, trigger on all tables in schema public from service_role;
do $maintain$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from anon, authenticated, service_role';
  end if;
end
$maintain$;
-- Audit tables are written only by the functions above.
revoke all on public.shift_audit, public.staff_audit from service_role;
-- Same defaults for tables created later by migrations.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from service_role;
