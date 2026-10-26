-- Holidays (férias) and days off (folgas).
-- Staff ask in the app; the manager of their department approves or declines;
-- managers can also add leave directly (already approved). Approved leave
-- shows on the roster and blocks rostering that person on those days.
-- Additive: one new table, new functions, and the two roster functions are
-- replaced with the same signatures (week view now includes leave; setting a
-- shift on an approved-leave day is refused).

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id),
  kind text not null check (kind in ('HOLIDAY', 'DAY_OFF')),
  start_date date not null,
  end_date date not null,
  note text check (note is null or length(note) <= 200),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED')),
  requested_by uuid references public.staff(id),
  decided_by uuid references public.staff(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint leave_requests_dates_check check (end_date >= start_date and end_date - start_date <= 62),
  constraint leave_requests_day_off_check check (kind <> 'DAY_OFF' or end_date = start_date)
);
create index if not exists leave_requests_staff_idx on public.leave_requests (staff_id, start_date);
create index if not exists leave_requests_dates_idx on public.leave_requests (start_date, end_date);

alter table public.leave_requests enable row level security;
revoke all on public.leave_requests from anon, authenticated;

create or replace function public.mh_leave_json(r public.leave_requests)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', r.id, 'staff_id', r.staff_id, 'kind', r.kind,
    'start_date', r.start_date, 'end_date', r.end_date, 'note', r.note,
    'status', r.status, 'created_at', r.created_at, 'decided_at', r.decided_at,
    'requested_by_manager', r.requested_by is distinct from r.staff_id)
$function$;

-- Shared checks for a new request (by the person or by a manager).
create or replace function public.mh_leave_insert(
  p_staff public.staff,
  p_by uuid,
  p_kind text,
  p_start date,
  p_end date,
  p_note text,
  p_status text
)
returns public.leave_requests
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_kind text := upper(trim(coalesce(p_kind, '')));
  v_end date := case when upper(trim(coalesce(p_kind, ''))) = 'DAY_OFF' then p_start else p_end end;
  v_row public.leave_requests%rowtype;
begin
  if v_kind not in ('HOLIDAY', 'DAY_OFF') or p_start is null or v_end is null
     or v_end < p_start or v_end - p_start > 62 then
    raise exception 'INVALID_INPUT';
  end if;
  -- one request at a time per person per day (pending or approved)
  perform pg_advisory_xact_lock(hashtext('marinara-leave-' || p_staff.id::text));
  if exists (
    select 1 from public.leave_requests l
     where l.staff_id = p_staff.id and l.status in ('PENDING', 'APPROVED')
       and l.start_date <= v_end and l.end_date >= p_start
  ) then
    raise exception 'LEAVE_OVERLAP';
  end if;

  insert into public.leave_requests (staff_id, kind, start_date, end_date, note, status, requested_by,
                                     decided_by, decided_at)
  values (p_staff.id, v_kind, p_start, v_end, nullif(left(trim(coalesce(p_note, '')), 200), ''), p_status, p_by,
          case when p_status = 'APPROVED' then p_by end,
          case when p_status = 'APPROVED' then now() end)
  returning * into v_row;
  return v_row;
end $function$;

-- Staff: ask for leave (always PENDING). p_staff_id comes from the verified session.
create or replace function public.staff_leave_request(
  p_staff_id uuid,
  p_kind text,
  p_start date,
  p_end date,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  st public.staff%rowtype;
begin
  select * into st from public.staff where id = p_staff_id and active;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
  if p_start < (now() at time zone 'Australia/Brisbane')::date then raise exception 'LEAVE_IN_PAST'; end if;
  return public.mh_leave_json(public.mh_leave_insert(st, st.id, p_kind, p_start, p_end, p_note, 'PENDING'));
end $function$;

-- Staff: cancel their own request (pending, or approved and not started yet).
create or replace function public.staff_leave_cancel(p_staff_id uuid, p_leave_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.leave_requests%rowtype;
begin
  select * into r from public.leave_requests where id = p_leave_id and staff_id = p_staff_id for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  if r.status not in ('PENDING', 'APPROVED')
     or (r.status = 'APPROVED' and r.start_date <= (now() at time zone 'Australia/Brisbane')::date) then
    raise exception 'LEAVE_NOT_CANCELLABLE';
  end if;
  update public.leave_requests set status = 'CANCELLED', decided_at = now() where id = r.id
  returning * into r;
  return public.mh_leave_json(r);
end $function$;

-- Staff: their own requests from 60 days ago onwards.
create or replace function public.staff_leave_list(p_staff_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(public.mh_leave_json(l) order by l.start_date desc), '[]'::jsonb)
    from public.leave_requests l
   where l.staff_id = p_staff_id
     and l.end_date >= (now() at time zone 'Australia/Brisbane')::date - 60
$function$;

-- Manager: add leave for someone in their scope, already approved.
create or replace function public.manager_leave_create(
  p_manager_id uuid,
  p_staff_id uuid,
  p_kind text,
  p_start date,
  p_end date,
  p_note text
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
begin
  select * into st from public.staff where id = p_staff_id and active;
  if not found or (st.location is distinct from mgr.location and mgr.role <> 'admin') then
    raise exception 'STAFF_NOT_FOUND';
  end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
  return public.mh_leave_json(public.mh_leave_insert(st, mgr.id, p_kind, p_start, p_end, p_note, 'APPROVED'));
end $function$;

-- Manager: approve / decline a pending request, or cancel an approved one.
-- p_decision: 'APPROVE', 'DECLINE' or 'CANCEL'.
create or replace function public.manager_leave_decide(
  p_manager_id uuid,
  p_leave_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  r public.leave_requests%rowtype;
  st public.staff%rowtype;
  v_decision text := upper(trim(coalesce(p_decision, '')));
  v_status text;
begin
  select * into r from public.leave_requests where id = p_leave_id for update;
  if not found then raise exception 'LEAVE_NOT_FOUND'; end if;
  select * into st from public.staff where id = r.staff_id;
  if st.location is distinct from mgr.location and mgr.role <> 'admin' then raise exception 'LEAVE_NOT_FOUND'; end if;
  if v_scope is not null and st.department is distinct from v_scope then raise exception 'DEPARTMENT_DENIED'; end if;

  if v_decision = 'APPROVE' and r.status = 'PENDING' then v_status := 'APPROVED';
  elsif v_decision = 'DECLINE' and r.status = 'PENDING' then v_status := 'DECLINED';
  elsif v_decision = 'CANCEL' and r.status = 'APPROVED' then v_status := 'CANCELLED';
  elsif v_decision in ('APPROVE', 'DECLINE', 'CANCEL') then raise exception 'LEAVE_NOT_PENDING';
  else raise exception 'INVALID_INPUT';
  end if;

  update public.leave_requests
     set status = v_status, decided_by = mgr.id, decided_at = now()
   where id = r.id
  returning * into r;
  return public.mh_leave_json(r);
end $function$;

-- Manager: requests in scope, either all pending or those touching a date range.
create or replace function public.manager_leave_list(
  p_manager_id uuid,
  p_location text,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
begin
  return coalesce((
    select jsonb_agg(public.mh_leave_json(l) || jsonb_build_object('name', s.name, 'department', s.department)
                     order by l.start_date, s.name)
      from public.leave_requests l
      join public.staff s on s.id = l.staff_id
     where s.location = v_location
       and (v_scope is null or s.department = v_scope)
       and (
         (p_from is null and l.status = 'PENDING')
         or (p_from is not null and l.status in ('PENDING', 'APPROVED')
             and l.start_date <= coalesce(p_to, p_from) and l.end_date >= p_from)
       )
  ), '[]'::jsonb);
end $function$;

-- Roster: refuse a working shift on an approved-leave day (OFF and clearing are fine).
create or replace function public.manager_roster_set(
  p_manager_id uuid,
  p_staff_id uuid,
  p_work_date date,
  p_code text,
  p_start time default null,
  p_end time default null
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
  v_code text := nullif(upper(trim(coalesce(p_code, ''))), '');
  v_old public.roster_entries%rowtype;
  v_start time := case when v_code = 'SHIFT' then p_start end;
  v_end time := case when v_code = 'SHIFT' then p_end end;
  v_old_times text;
  v_new_times text := case when v_code = 'SHIFT' then to_char(p_start, 'HH24:MI') || '-' || to_char(p_end, 'HH24:MI') end;
begin
  if p_work_date is null then raise exception 'INVALID_INPUT'; end if;
  if v_code is not null and v_code not in ('L', 'D', 'LD', 'OFF', 'SHIFT') then raise exception 'INVALID_INPUT'; end if;
  if v_code = 'SHIFT' and (p_start is null or p_end is null or p_start = p_end) then raise exception 'INVALID_INPUT'; end if;

  select * into st from public.staff where id = p_staff_id;
  if not found or not st.active
     or (st.location is distinct from mgr.location and mgr.role <> 'admin') then
    raise exception 'STAFF_NOT_FOUND';
  end if;
  if v_scope is not null and st.department is distinct from v_scope then
    raise exception 'DEPARTMENT_DENIED';
  end if;

  if v_code in ('L', 'D', 'LD', 'SHIFT') and exists (
    select 1 from public.leave_requests l
     where l.staff_id = p_staff_id and l.status = 'APPROVED'
       and p_work_date between l.start_date and l.end_date
  ) then
    raise exception 'ON_LEAVE';
  end if;

  select * into v_old from public.roster_entries
   where staff_id = p_staff_id and work_date = p_work_date for update;
  v_old_times := case when v_old.code = 'SHIFT'
    then to_char(v_old.start_time, 'HH24:MI') || '-' || to_char(v_old.end_time, 'HH24:MI') end;

  if v_code is null then
    delete from public.roster_entries where staff_id = p_staff_id and work_date = p_work_date;
  else
    insert into public.roster_entries (staff_id, work_date, code, start_time, end_time, updated_by, updated_at)
    values (p_staff_id, p_work_date, v_code, v_start, v_end, mgr.id, now())
    on conflict (staff_id, work_date)
    do update set code = excluded.code, start_time = excluded.start_time, end_time = excluded.end_time,
                  updated_by = excluded.updated_by, updated_at = now();
  end if;

  if v_old.code is distinct from v_code or v_old_times is distinct from v_new_times then
    insert into public.roster_audit (staff_ref, work_date, changed_by, old_code, new_code, old_times, new_times)
    values (p_staff_id, p_work_date, mgr.id, v_old.code, v_code, v_old_times, v_new_times);
  end if;

  return jsonb_build_object('staff_id', p_staff_id, 'work_date', p_work_date, 'code', v_code,
                            'start_time', to_char(v_start, 'HH24:MI'), 'end_time', to_char(v_end, 'HH24:MI'));
end $function$;

-- Roster week now also lists leave (approved and pending) touching the week.
create or replace function public.manager_roster_week(
  p_manager_id uuid,
  p_location text,
  p_week_start date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'INVALID_INPUT';
  end if;

  return jsonb_build_object(
    'location', v_location,
    'week_start', p_week_start,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('staff_id', e.staff_id, 'work_date', e.work_date, 'code', e.code,
                                          'start_time', to_char(e.start_time, 'HH24:MI'),
                                          'end_time', to_char(e.end_time, 'HH24:MI'))
                       order by e.work_date)
        from public.roster_entries e
        join public.staff s on s.id = e.staff_id
       where s.location = v_location
         and (v_scope is null or s.department = v_scope)
         and e.work_date >= p_week_start and e.work_date < p_week_start + 7
    ), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('department', r.department, 'service', r.service,
                                          'start_time', to_char(r.start_time, 'HH24:MI'),
                                          'end_time', to_char(r.end_time, 'HH24:MI')))
        from public.roster_services r
       where r.location = v_location
         and (v_scope is null or r.department = v_scope)
    ), '[]'::jsonb),
    'leave', coalesce((
      select jsonb_agg(public.mh_leave_json(l) order by l.start_date)
        from public.leave_requests l
        join public.staff s on s.id = l.staff_id
       where s.location = v_location
         and (v_scope is null or s.department = v_scope)
         and l.status in ('PENDING', 'APPROVED')
         and l.start_date < p_week_start + 7 and l.end_date >= p_week_start
    ), '[]'::jsonb)
  );
end $function$;

revoke all on function public.mh_leave_json(public.leave_requests) from public, anon, authenticated;
revoke all on function public.mh_leave_insert(public.staff, uuid, text, date, date, text, text) from public, anon, authenticated;
revoke all on function public.staff_leave_request(uuid, text, date, date, text) from public, anon, authenticated;
revoke all on function public.staff_leave_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function public.staff_leave_list(uuid) from public, anon, authenticated;
revoke all on function public.manager_leave_create(uuid, uuid, text, date, date, text) from public, anon, authenticated;
revoke all on function public.manager_leave_decide(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.manager_leave_list(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.staff_leave_request(uuid, text, date, date, text) to service_role;
grant execute on function public.staff_leave_cancel(uuid, uuid) to service_role;
grant execute on function public.staff_leave_list(uuid) to service_role;
grant execute on function public.manager_leave_create(uuid, uuid, text, date, date, text) to service_role;
grant execute on function public.manager_leave_decide(uuid, uuid, text) to service_role;
grant execute on function public.manager_leave_list(uuid, text, date, date) to service_role;
