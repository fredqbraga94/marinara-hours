-- Rollback of 20261020020000_leave.sql
-- Puts the two roster functions back to their 20261020010000_roster.sql
-- versions (no leave), then removes the leave functions and table (and the
-- leave data in it). Roster, staff, shift and audit rows are not touched.

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
    ), '[]'::jsonb)
  );
end $function$;

drop function if exists public.manager_leave_list(uuid, text, date, date);
drop function if exists public.manager_leave_decide(uuid, uuid, text);
drop function if exists public.manager_leave_create(uuid, uuid, text, date, date, text);
drop function if exists public.staff_leave_list(uuid);
drop function if exists public.staff_leave_cancel(uuid, uuid);
drop function if exists public.staff_leave_request(uuid, text, date, date, text);
drop function if exists public.mh_leave_insert(public.staff, uuid, text, date, date, text, text);
drop function if exists public.mh_leave_json(public.leave_requests);
drop table if exists public.leave_requests;
