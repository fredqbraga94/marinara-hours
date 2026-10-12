-- Audit trail and integrity hardening. Non-destructive: no rows are changed.
--
-- 1. Deleting a shift no longer deletes its audit history
--    (shift_audit.shift_id: ON DELETE CASCADE -> ON DELETE SET NULL).
-- 2. A shift can never have two open breaks at the same time
--    (double tap on Start Break). Verified: 0 existing duplicates.
-- 3. Remove table privileges the API roles never need (TRUNCATE ignores RLS).
-- 4. manager_edit_shift: the edit (times + break) happens in one
--    transaction with row locks and an audit record. Previously the Edge
--    Function updated the shift, deleted breaks and inserted a break in three
--    separate calls, so a failure in between could lose break data.

alter table public.shift_audit
  drop constraint if exists shift_audit_shift_id_fkey;

alter table public.shift_audit
  add constraint shift_audit_shift_id_fkey
  foreign key (shift_id) references public.shifts(id) on delete set null;

create unique index if not exists breaks_one_open_per_shift_uidx
  on public.breaks (shift_id)
  where break_end is null;

create index if not exists shift_audit_shift_id_idx
  on public.shift_audit (shift_id);

revoke truncate, references, trigger
  on public.staff, public.shifts, public.breaks, public.shift_audit,
     public.staff_sessions, public.pin_attempts
  from anon, authenticated;

create or replace function public.manager_edit_shift(
  p_manager_id uuid,
  p_shift_id uuid,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_break_minutes integer
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
  v_old jsonb;
  v_breaks jsonb;
  v_break_seconds numeric;
begin
  if p_manager_id is null or p_shift_id is null or p_clock_in is null
     or p_clock_out is null or p_break_minutes is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into mgr from public.staff where id = p_manager_id and active = true;
  if not found or mgr.role not in ('manager', 'kitchen_manager', 'floor_manager') then
    raise exception 'MANAGER_REQUIRED';
  end if;

  v_scope := case mgr.role when 'kitchen_manager' then 'Kitchen' when 'floor_manager' then 'Floor' else null end;

  select * into sh from public.shifts where id = p_shift_id for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;

  select * into st from public.staff where id = sh.staff_id;
  if not found or st.active is not true
     or st.location is distinct from coalesce(mgr.location, 'Hawthorne') then
    raise exception 'SHIFT_NOT_FOUND';
  end if;

  if v_scope is not null and st.department is distinct from v_scope then
    raise exception 'DEPARTMENT_DENIED';
  end if;

  if sh.clock_out is null then raise exception 'SHIFT_STILL_OPEN'; end if;
  if sh.approved then raise exception 'SHIFT_APPROVED'; end if;
  if p_clock_out <= p_clock_in then raise exception 'CLOCK_OUT_BEFORE_CLOCK_IN'; end if;
  if p_clock_out > v_now + interval '1 minute' then raise exception 'CLOCK_OUT_IN_FUTURE'; end if;
  if p_clock_out - p_clock_in > interval '24 hours' then raise exception 'SHIFT_TOO_LONG'; end if;
  if p_break_minutes < 0 or p_break_minutes > 720
     or make_interval(mins => p_break_minutes) >= (p_clock_out - p_clock_in) then
    raise exception 'INVALID_BREAK';
  end if;

  if exists (
    select 1 from public.shifts o
    where o.staff_id = sh.staff_id
      and o.id <> sh.id
      and o.clock_in < p_clock_out
      and coalesce(o.clock_out, 'infinity'::timestamptz) > p_clock_in
  ) then
    raise exception 'SHIFT_OVERLAP';
  end if;

  perform 1 from public.breaks where shift_id = sh.id for update;

  select jsonb_build_object(
    'shift', to_jsonb(sh),
    'breaks', coalesce((select jsonb_agg(to_jsonb(b) order by b.break_start)
                        from public.breaks b where b.shift_id = sh.id), '[]'::jsonb)
  ) into v_old;

  update public.shifts
  set clock_in = p_clock_in, clock_out = p_clock_out, status = 'completed'
  where id = sh.id;

  delete from public.breaks where shift_id = sh.id;

  -- Same convention as before: one break ending at Clock Out.
  if p_break_minutes > 0 then
    insert into public.breaks (shift_id, break_start, break_end)
    values (sh.id, p_clock_out - make_interval(mins => p_break_minutes), p_clock_out);
  end if;

  select * into sh from public.shifts where id = p_shift_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'break_start', b.break_start, 'break_end', b.break_end)
                            order by b.break_start), '[]'::jsonb),
         coalesce(sum(extract(epoch from (b.break_end - b.break_start))), 0)
  into v_breaks, v_break_seconds
  from public.breaks b where b.shift_id = sh.id;

  insert into public.shift_audit (shift_id, changed_by, old_data, new_data, changed_at)
  values (sh.id, mgr.id, v_old,
          jsonb_build_object('action', 'manager_edit_shift', 'shift', to_jsonb(sh), 'breaks', v_breaks,
                             'manager', jsonb_build_object('id', mgr.id, 'name', mgr.name, 'role', mgr.role),
                             'performed_at', v_now),
          v_now);

  return jsonb_build_object(
    'id', sh.id, 'staff_id', sh.staff_id, 'clock_in', sh.clock_in, 'clock_out', sh.clock_out,
    'status', sh.status, 'approved', sh.approved, 'notes', sh.notes, 'breaks', v_breaks,
    'break_minutes', round(v_break_seconds / 60),
    'hours', round(greatest(0, extract(epoch from (sh.clock_out - sh.clock_in)) - v_break_seconds) / 3600, 2)
  );
end;
$function$;

revoke all on function public.manager_edit_shift(uuid, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.manager_edit_shift(uuid, uuid, timestamptz, timestamptz, integer) to service_role;
