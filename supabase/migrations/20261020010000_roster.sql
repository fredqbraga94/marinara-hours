-- Weekly roster, like the paper one on the wall: per unit and department,
-- one cell per person per day with L (lunch), D (dinner), LD (both) or OFF.
-- Additive only: new tables and new functions. Nothing existing is changed.
-- Tables are reached only through the audited functions below (service role);
-- RLS is on with no policies, so the public API keys cannot read or write them.

-- Usual times of each service, per unit and department. Used to turn the
-- roster into planned hours (for the student visa warning). Editable later.
create table if not exists public.roster_services (
  location text not null,
  department text not null check (department in ('Kitchen', 'Floor')),
  service text not null check (service in ('L', 'D')),
  start_time time not null,
  end_time time not null,
  updated_at timestamptz not null default now(),
  primary key (location, department, service)
);

create table if not exists public.roster_entries (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id),
  work_date date not null,
  code text not null check (code in ('L', 'D', 'LD', 'OFF')),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  unique (staff_id, work_date)
);
create index if not exists roster_entries_date_idx on public.roster_entries (work_date);

create table if not exists public.roster_audit (
  id bigint generated always as identity primary key,
  staff_ref uuid not null,
  work_date date not null,
  changed_by uuid references public.staff(id),
  old_code text,
  new_code text,
  changed_at timestamptz not null default now()
);

alter table public.roster_services enable row level security;
alter table public.roster_entries enable row level security;
alter table public.roster_audit enable row level security;
revoke all on public.roster_services, public.roster_entries, public.roster_audit from anon, authenticated;

-- Set or clear one cell. p_code: 'L', 'D', 'LD', 'OFF', or null/'' to clear.
create or replace function public.manager_roster_set(
  p_manager_id uuid,
  p_staff_id uuid,
  p_work_date date,
  p_code text
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
  v_old text;
begin
  if p_work_date is null then raise exception 'INVALID_INPUT'; end if;
  if v_code is not null and v_code not in ('L', 'D', 'LD', 'OFF') then raise exception 'INVALID_INPUT'; end if;

  select * into st from public.staff where id = p_staff_id;
  if not found or not st.active
     or (st.location is distinct from mgr.location and mgr.role <> 'admin') then
    raise exception 'STAFF_NOT_FOUND';
  end if;
  if v_scope is not null and st.department is distinct from v_scope then
    raise exception 'DEPARTMENT_DENIED';
  end if;

  select code into v_old from public.roster_entries
   where staff_id = p_staff_id and work_date = p_work_date for update;

  if v_code is null then
    delete from public.roster_entries where staff_id = p_staff_id and work_date = p_work_date;
  else
    insert into public.roster_entries (staff_id, work_date, code, updated_by, updated_at)
    values (p_staff_id, p_work_date, v_code, mgr.id, now())
    on conflict (staff_id, work_date)
    do update set code = excluded.code, updated_by = excluded.updated_by, updated_at = now();
  end if;

  if v_old is distinct from v_code then
    insert into public.roster_audit (staff_ref, work_date, changed_by, old_code, new_code)
    values (p_staff_id, p_work_date, mgr.id, v_old, v_code);
  end if;

  return jsonb_build_object('staff_id', p_staff_id, 'work_date', p_work_date, 'code', v_code);
end $function$;

-- One unit's roster for the week starting p_week_start (a Monday), limited to
-- the manager's department when the manager is department-scoped.
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
      select jsonb_agg(jsonb_build_object('staff_id', e.staff_id, 'work_date', e.work_date, 'code', e.code)
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

revoke all on function public.manager_roster_set(uuid, uuid, date, text) from public, anon, authenticated;
revoke all on function public.manager_roster_week(uuid, text, date) from public, anon, authenticated;
grant execute on function public.manager_roster_set(uuid, uuid, date, text) to service_role;
grant execute on function public.manager_roster_week(uuid, text, date) to service_role;
