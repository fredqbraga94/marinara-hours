-- Two more council records (FSANZ Standard 3.2.2A, Eat Safe Brisbane):
-- 1. Food temperatures: cooking and reheating (75°C or above), hot holding
--    (60°C or above), cold holding (5°C or below) and cooling (from 60°C to
--    21°C within 2 hours, then to 5°C within 6 hours of the start). A cooling
--    batch is one start reading plus the 2-hour and the 6-hour readings.
-- 2. Cleaning: the list of what is cleaned (every day or once a week, and how)
--    and the weekly sheet where each task is ticked with who did it.
-- Every record keeps who typed it, who did it and when (set by the database).
-- A food reading outside the safe range needs a corrective action. A food
-- reading can be corrected the same day; its first values stay on record.
-- A cleaning tick can be undone only the same day.
-- Any manager; one list per location (the Administrator's viewed unit).
-- Additive only: three new tables and ten new functions. Nothing existing changes.

create table if not exists public.food_temps (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  food text not null check (length(trim(food)) between 1 and 80),
  check_type text not null check (check_type in ('cook', 'reheat', 'hot', 'cold', 'cool')),
  stage smallint not null default 0 check (stage between 0 and 2),
  batch_id uuid references public.food_temps(id),
  temp numeric(5,1) not null check (temp between -40 and 120),
  ok boolean not null,
  action text check (action is null or length(action) <= 200),
  checked_by uuid references public.staff(id),
  recorded_by uuid not null references public.staff(id),
  recorded_at timestamptz not null default now(),
  edited_at timestamptz,
  edited_by uuid references public.staff(id),
  original jsonb,
  check ((check_type = 'cool') or (stage = 0 and batch_id is null)),
  check ((stage = 0) = (batch_id is null))
);
create index if not exists food_temps_location_idx on public.food_temps (location, recorded_at desc);
create unique index if not exists food_temps_batch_stage_idx on public.food_temps (batch_id, stage) where batch_id is not null;

create table if not exists public.cleaning_tasks (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  name text not null check (length(trim(name)) between 1 and 80),
  how text check (how is null or length(how) <= 120),
  frequency text not null check (frequency in ('daily', 'weekly')),
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now()
);
create index if not exists cleaning_tasks_location_idx on public.cleaning_tasks (location) where active;

create table if not exists public.cleaning_logs (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  task_id uuid not null references public.cleaning_tasks(id),
  day date not null,
  done_by uuid not null references public.staff(id),
  recorded_by uuid not null references public.staff(id),
  recorded_at timestamptz not null default now(),
  unique (task_id, day)
);
create index if not exists cleaning_logs_location_idx on public.cleaning_logs (location, day);

alter table public.food_temps enable row level security;
alter table public.cleaning_tasks enable row level security;
alter table public.cleaning_logs enable row level security;
revoke all on public.food_temps, public.cleaning_tasks, public.cleaning_logs from anon, authenticated;

-- Safe range. Cooling: the 2-hour reading 21°C or below within 2 hours of the
-- start, the 6-hour reading 5°C or below within 6 hours (5 minutes to type it).
create or replace function public.mh_food_ok(p_check text, p_stage integer, p_temp numeric, p_minutes numeric)
returns boolean language sql immutable set search_path to 'public'
as $function$
  select case p_check
    when 'cook' then p_temp >= 75
    when 'reheat' then p_temp >= 75
    when 'hot' then p_temp >= 60
    when 'cold' then p_temp <= 5
    when 'cool' then case p_stage
      when 0 then true
      when 1 then p_temp <= 21 and coalesce(p_minutes, 0) <= 125
      when 2 then p_temp <= 5 and coalesce(p_minutes, 0) <= 365
      else false end
    else false end
$function$;

create or replace function public.mh_food_json(f public.food_temps)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', f.id, 'food', f.food, 'check', f.check_type, 'stage', f.stage, 'batch_id', f.batch_id,
    'day', (f.recorded_at at time zone 'Australia/Brisbane')::date,
    'temp', f.temp, 'ok', f.ok, 'action', f.action,
    'minutes', case when f.batch_id is null then null else
      round(extract(epoch from f.recorded_at - (select b.recorded_at from public.food_temps b where b.id = f.batch_id)) / 60) end,
    'recorded_at', f.recorded_at, 'recorded_by', (select s.name from public.staff s where s.id = f.recorded_by),
    'checked_by_id', coalesce(f.checked_by, f.recorded_by),
    'checked_by', (select s.name from public.staff s where s.id = coalesce(f.checked_by, f.recorded_by)),
    'edited_at', f.edited_at, 'edited_by', (select s.name from public.staff s where s.id = f.edited_by), 'original', f.original)
$function$;

-- One day of food readings (Brisbane day; default today), the people who can
-- be chosen as "checked by", the foods typed before (for suggestions) and the
-- cooling batches still waiting for a reading (started in the last 8 hours).
create or replace function public.manager_food_day(p_manager_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_today date := (now() at time zone 'Australia/Brisbane')::date;
  v_day date := least(coalesce(p_day, v_today), v_today);
begin
  return jsonb_build_object(
    'day', v_day, 'today', v_today, 'location', mgr.location,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by lower(s.name))
                          from public.staff s where s.active and s.location = mgr.location), '[]'::jsonb),
    'foods', coalesce((select jsonb_agg(x.food order by x.n desc, lower(x.food)) from (
                         select f.food, count(*) as n from public.food_temps f
                          where f.location = mgr.location and f.stage = 0 and f.recorded_at > now() - interval '60 days'
                          group by f.food order by count(*) desc limit 40) x), '[]'::jsonb),
    'records', coalesce((select jsonb_agg(public.mh_food_json(f) order by f.recorded_at)
                           from public.food_temps f
                          where f.location = mgr.location
                            and (f.recorded_at at time zone 'Australia/Brisbane')::date = v_day), '[]'::jsonb),
    'cooling', coalesce((select jsonb_agg(jsonb_build_object(
                           'start', public.mh_food_json(b),
                           'next', (select coalesce(max(c.stage), 0) + 1 from public.food_temps c where c.batch_id = b.id))
                           order by b.recorded_at)
                           from public.food_temps b
                          where b.location = mgr.location and b.check_type = 'cool' and b.stage = 0
                            and b.recorded_at > now() - interval '8 hours'
                            and not exists (select 1 from public.food_temps c where c.batch_id = b.id and c.stage = 2)), '[]'::jsonb));
end $function$;

-- Save one reading. p_entry: {food, check: cook|reheat|hot|cold|cool, temp,
-- action?, checked_by?} or, for the next cooling reading, {batch_id, temp,
-- action?, checked_by?}. Outside the safe range: ACTION_REQUIRED.
create or replace function public.manager_food_record(p_manager_id uuid, p_entry jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_food text := nullif(left(trim(coalesce(p_entry->>'food', '')), 80), '');
  v_check text := p_entry->>'check';
  v_action text := nullif(left(trim(coalesce(p_entry->>'action', '')), 200), '');
  v_checker uuid := public.mh_temp_checker(mgr, p_entry->>'checked_by');
  v_temp numeric;
  v_stage integer := 0;
  v_batch public.food_temps%rowtype;
  v_minutes numeric;
  v_ok boolean;
  v_row public.food_temps%rowtype;
begin
  begin
    v_temp := round((p_entry->>'temp')::numeric, 1);
  exception when others then raise exception 'INVALID_INPUT';
  end;
  if v_temp is null or v_temp < -40 or v_temp > 120 then raise exception 'INVALID_INPUT'; end if;
  if p_entry ? 'batch_id' and p_entry->>'batch_id' is not null then
    begin
      select * into v_batch from public.food_temps
       where id = (p_entry->>'batch_id')::uuid and location = mgr.location and check_type = 'cool' and stage = 0
       for update;
    exception when invalid_text_representation then raise exception 'ITEM_NOT_FOUND';
    end;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
    select coalesce(max(stage), 0) + 1 into v_stage from public.food_temps where batch_id = v_batch.id;
    if v_stage > 2 then raise exception 'ALREADY_DONE'; end if;
    v_food := v_batch.food; v_check := 'cool';
    v_minutes := extract(epoch from now() - v_batch.recorded_at) / 60;
  else
    if v_food is null or v_check is null or v_check not in ('cook', 'reheat', 'hot', 'cold', 'cool') then
      raise exception 'INVALID_INPUT';
    end if;
  end if;
  v_ok := public.mh_food_ok(v_check, v_stage, v_temp, v_minutes);
  if not v_ok and v_action is null then raise exception 'ACTION_REQUIRED'; end if;
  insert into public.food_temps (location, food, check_type, stage, batch_id, temp, ok, action, checked_by, recorded_by)
  values (mgr.location, v_food, v_check, v_stage, v_batch.id, v_temp, v_ok, v_action, v_checker, p_manager_id)
  returning * into v_row;
  return public.mh_food_json(v_row);
end $function$;

-- Correct a reading of today (a typo in the food, a wrong number, who did it).
-- p_entry: {food, temp, action?, checked_by?}. The first values stay in "original".
create or replace function public.manager_food_edit(p_manager_id uuid, p_id uuid, p_entry jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_old public.food_temps%rowtype;
  v_row public.food_temps%rowtype;
  v_food text := nullif(left(trim(coalesce(p_entry->>'food', '')), 80), '');
  v_action text := nullif(left(trim(coalesce(p_entry->>'action', '')), 200), '');
  v_checker uuid := public.mh_temp_checker(mgr, p_entry->>'checked_by');
  v_temp numeric;
  v_minutes numeric;
  v_ok boolean;
begin
  begin
    v_temp := round((p_entry->>'temp')::numeric, 1);
  exception when others then raise exception 'INVALID_INPUT';
  end;
  if v_temp is null or v_temp < -40 or v_temp > 120 then raise exception 'INVALID_INPUT'; end if;
  select * into v_old from public.food_temps
   where id = p_id and location = mgr.location
     and (recorded_at at time zone 'Australia/Brisbane')::date = (now() at time zone 'Australia/Brisbane')::date
   for update;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  if v_old.stage > 0 then
    v_food := v_old.food;  -- the food of a cooling batch is changed on its start reading
    v_minutes := extract(epoch from v_old.recorded_at - (select b.recorded_at from public.food_temps b where b.id = v_old.batch_id)) / 60;
  end if;
  if v_food is null then raise exception 'INVALID_INPUT'; end if;
  v_ok := public.mh_food_ok(v_old.check_type, v_old.stage, v_temp, v_minutes);
  if not v_ok and v_action is null then raise exception 'ACTION_REQUIRED'; end if;
  update public.food_temps
     set food = v_food, temp = v_temp, ok = v_ok, action = v_action, checked_by = v_checker,
         edited_at = now(), edited_by = p_manager_id,
         original = coalesce(original, jsonb_build_object('food', v_old.food, 'temp', v_old.temp, 'action', v_old.action,
                      'checked_by', (select s.name from public.staff s where s.id = coalesce(v_old.checked_by, v_old.recorded_by))))
   where id = p_id
  returning * into v_row;
  if v_row.stage = 0 and v_row.check_type = 'cool' then
    update public.food_temps set food = v_food where batch_id = v_row.id;
  end if;
  return public.mh_food_json(v_row);
end $function$;

-- Food readings of the last p_days days (1 to 120), oldest first, for the council.
create or replace function public.manager_food_history(p_manager_id uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_days integer := greatest(1, least(coalesce(p_days, 90), 120));
begin
  return jsonb_build_object('days', v_days, 'location', mgr.location,
    'records', coalesce((select jsonb_agg(public.mh_food_json(f) order by f.recorded_at)
                           from public.food_temps f
                          where f.location = mgr.location and f.recorded_at > now() - make_interval(days => v_days)), '[]'::jsonb));
end $function$;

-- The cleaning sheet: Monday p_start to Sunday. Tasks on the list (and any
-- removed one ticked that week) and the ticks of the week.
create or replace function public.manager_clean_week(p_manager_id uuid, p_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_today date := (now() at time zone 'Australia/Brisbane')::date;
  v_start date := coalesce(p_start, v_today);
begin
  v_start := v_start - ((extract(isodow from v_start)::int - 1));
  return (
    with logs as (
      select l.* from public.cleaning_logs l
       where l.location = mgr.location and l.day between v_start and v_start + 6
    )
    select jsonb_build_object(
      'start', v_start, 'today', v_today, 'location', mgr.location,
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by lower(s.name))
                            from public.staff s where s.active and s.location = mgr.location), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'how', t.how,
                                                             'frequency', t.frequency, 'active', t.active)
                                          order by case t.frequency when 'daily' then 0 else 1 end, t.created_at, lower(t.name))
                           from public.cleaning_tasks t
                          where t.location = mgr.location
                            and (t.active or exists (select 1 from logs where logs.task_id = t.id))), '[]'::jsonb),
      'done', coalesce((select jsonb_agg(jsonb_build_object('task_id', l.task_id, 'day', l.day,
                          'by_id', l.done_by, 'by', (select s.name from public.staff s where s.id = l.done_by),
                          'recorded_by', (select s.name from public.staff s where s.id = l.recorded_by),
                          'recorded_at', l.recorded_at) order by l.day, l.recorded_at)
                          from logs l), '[]'::jsonb)));
end $function$;

-- Add or change a cleaning task, or take it off the list (active = false).
-- p_item: {id?, name, how?, frequency: daily|weekly, active?}. Ticks are kept.
create or replace function public.manager_clean_task_save(p_manager_id uuid, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_name text := left(trim(coalesce(p_item->>'name', '')), 80);
  v_how text := nullif(left(trim(coalesce(p_item->>'how', '')), 120), '');
  v_freq text := p_item->>'frequency';
  v_active boolean := coalesce((p_item->>'active')::boolean, true);
  v_row public.cleaning_tasks%rowtype;
begin
  if p_item ? 'id' and p_item->>'id' is not null then
    update public.cleaning_tasks
       set name = case when v_name = '' then name else v_name end,
           how = case when p_item ? 'how' then v_how else how end,
           frequency = case when v_freq in ('daily', 'weekly') then v_freq else frequency end,
           active = v_active
     where id = (p_item->>'id')::uuid and location = mgr.location
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    if v_name = '' or v_freq is null or v_freq not in ('daily', 'weekly') then raise exception 'INVALID_INPUT'; end if;
    insert into public.cleaning_tasks (location, name, how, frequency, created_by)
    values (mgr.location, v_name, v_how, v_freq, p_manager_id)
    returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'how', v_row.how, 'frequency', v_row.frequency, 'active', v_row.active);
end $function$;

-- Tick a task as done today (p_done true, with who did it) or undo today's tick.
create or replace function public.manager_clean_mark(p_manager_id uuid, p_task_id uuid, p_done boolean, p_checked_by text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_today date := (now() at time zone 'Australia/Brisbane')::date;
  v_who uuid := public.mh_temp_checker(mgr, p_checked_by);
begin
  if not exists (select 1 from public.cleaning_tasks t where t.id = p_task_id and t.location = mgr.location and t.active) then
    raise exception 'ITEM_NOT_FOUND';
  end if;
  if coalesce(p_done, true) then
    insert into public.cleaning_logs (location, task_id, day, done_by, recorded_by)
    values (mgr.location, p_task_id, v_today, v_who, p_manager_id)
    on conflict (task_id, day) do update set done_by = excluded.done_by, recorded_by = excluded.recorded_by, recorded_at = now();
  else
    delete from public.cleaning_logs where task_id = p_task_id and day = v_today and location = mgr.location;
  end if;
  return jsonb_build_object('task_id', p_task_id, 'day', v_today, 'done', coalesce(p_done, true));
end $function$;

-- Cleaning ticks of the last p_days days (1 to 120), for the council.
create or replace function public.manager_clean_history(p_manager_id uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_days integer := greatest(1, least(coalesce(p_days, 90), 120));
begin
  return jsonb_build_object('days', v_days, 'location', mgr.location,
    'records', coalesce((select jsonb_agg(jsonb_build_object('day', l.day, 'task', t.name, 'how', t.how, 'frequency', t.frequency,
                            'by', (select s.name from public.staff s where s.id = l.done_by),
                            'recorded_by', (select s.name from public.staff s where s.id = l.recorded_by),
                            'recorded_at', l.recorded_at) order by l.day, l.recorded_at)
                           from public.cleaning_logs l join public.cleaning_tasks t on t.id = l.task_id
                          where l.location = mgr.location
                            and l.day > (now() at time zone 'Australia/Brisbane')::date - v_days), '[]'::jsonb));
end $function$;

revoke all on function public.mh_food_ok(text, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function public.mh_food_json(public.food_temps) from public, anon, authenticated;
revoke all on function public.manager_food_day(uuid, date) from public, anon, authenticated;
revoke all on function public.manager_food_record(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_food_edit(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_food_history(uuid, integer) from public, anon, authenticated;
revoke all on function public.manager_clean_week(uuid, date) from public, anon, authenticated;
revoke all on function public.manager_clean_task_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_clean_mark(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.manager_clean_history(uuid, integer) from public, anon, authenticated;
grant execute on function public.mh_food_ok(text, integer, numeric, numeric) to service_role;
grant execute on function public.mh_food_json(public.food_temps) to service_role;
grant execute on function public.manager_food_day(uuid, date) to service_role;
grant execute on function public.manager_food_record(uuid, jsonb) to service_role;
grant execute on function public.manager_food_edit(uuid, uuid, jsonb) to service_role;
grant execute on function public.manager_food_history(uuid, integer) to service_role;
grant execute on function public.manager_clean_week(uuid, date) to service_role;
grant execute on function public.manager_clean_task_save(uuid, jsonb) to service_role;
grant execute on function public.manager_clean_mark(uuid, uuid, boolean, text) to service_role;
grant execute on function public.manager_clean_history(uuid, integer) to service_role;
