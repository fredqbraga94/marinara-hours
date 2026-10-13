-- Rollback of 20261013010000_integrity_audit_privileges.sql
-- Returns the database to what Edge Function v37 (and v36) expect.
-- Run AFTER the rollback of 20261013020000 if that one was applied.
--
-- Deliberately kept (they hold history or only remove risk, and v37 works with them):
--   - shift_audit.action / shift_ref columns, staff_audit table and their rows;
--   - shift_audit foreign key ON DELETE SET NULL (restoring CASCADE would delete
--     audit history whenever a shift is deleted);
--   - staff.pin_conflict_at column (v37 never reads it);
--   - revoked privileges of anon / authenticated (the app never uses them);
--   - the btree_gist extension.
-- Verified by tests/integration/hardening.mjs: after this script the four clock
-- functions are byte-identical to production (md5) and v37 passes its full suite.

drop function if exists public.manager_toggle_staff_audited(uuid, uuid);
drop function if exists public.manager_update_staff_audited(uuid, uuid, text, text, text, text);
drop function if exists public.manager_create_staff_audited(uuid, text, text, text);
drop function if exists public.mh_pin_in_use(text, uuid);
drop function if exists public.manager_set_shift_approved(uuid, uuid, boolean);
drop function if exists public.manager_delete_shift(uuid, uuid);
drop function if exists public.manager_create_shift(uuid, uuid, timestamptz, timestamptz, integer, text);
drop function if exists public.manager_edit_shift(uuid, uuid, timestamptz, timestamptz, integer);
drop function if exists public.mh_lock_shift(public.staff, uuid, boolean);
drop function if exists public.mh_shift_audit(uuid, public.staff, text, jsonb, jsonb);
drop function if exists public.mh_staff_json(uuid);
drop function if exists public.mh_shift_json(uuid);
drop function if exists public.mh_scope(text);
drop function if exists public.mh_manager(uuid);

drop index if exists public.breaks_one_open_per_shift_uidx;
alter table public.breaks drop constraint if exists breaks_no_overlap_per_shift;
alter table public.shifts drop constraint if exists shifts_no_overlap_per_staff;
alter table public.breaks drop constraint if exists breaks_end_not_before_start;
alter table public.shifts drop constraint if exists shifts_clock_out_not_before_in;

-- Production text of the staff clock functions (copied verbatim, md5-verified).
CREATE OR REPLACE FUNCTION public.clock_in_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sh public.shifts%rowtype;
begin
  if not exists(select 1 from public.staff where id=p_staff_id and active=true) then raise exception 'STAFF_NOT_FOUND'; end if;
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
  select * into sh from public.shifts where staff_id=p_staff_id and status='working' order by clock_in desc limit 1;
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
  select * into sh from public.shifts where staff_id=p_staff_id and status='break' order by clock_in desc limit 1;
  if not found then raise exception 'NO_ACTIVE_BREAK'; end if;
  select * into br from public.breaks where shift_id=sh.id and break_end is null order by break_start desc limit 1;
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
  select *
  into sh
  from public.shifts
  where staff_id = p_staff_id
    and status in ('working','break')
  order by clock_in desc
  limit 1;

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

revoke all on function public.clock_in_by_id(uuid) from public, anon, authenticated;
revoke all on function public.start_break_by_id(uuid) from public, anon, authenticated;
revoke all on function public.end_break_by_id(uuid) from public, anon, authenticated;
revoke all on function public.clock_out_by_id(uuid) from public, anon, authenticated;
grant execute on function public.clock_in_by_id(uuid) to service_role;
grant execute on function public.start_break_by_id(uuid) to service_role;
grant execute on function public.end_break_by_id(uuid) to service_role;
grant execute on function public.clock_out_by_id(uuid) to service_role;
