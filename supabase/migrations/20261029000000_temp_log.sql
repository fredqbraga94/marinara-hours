-- Temperature records for the council (FSANZ Standard 3.2.2A): daily checks of
-- fridges, freezers and hot holding at opening and at closing (the same sheet
-- as on paper: equipment x Opening/Closing x Monday to Sunday), and the
-- temperature of chilled/frozen deliveries. Every record keeps who made it and when (set by the database),
-- and records cannot be edited or deleted: a mistake is fixed with a new record.
-- A reading outside the safe range needs a corrective action written with it.
-- Limits: fridge and chilled delivery 5°C or below; freezer and frozen delivery
-- -15°C or below; hot holding 60°C or above.
-- Any manager (Administrator, Kitchen or Floor Manager). One list per location.
-- Additive only: two new tables and seven new functions. Nothing existing changes.

create table if not exists public.temp_equipment (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  name text not null check (length(trim(name)) between 1 and 60),
  kind text not null check (kind in ('fridge', 'freezer', 'hot')),
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now()
);
create index if not exists temp_equipment_location_idx on public.temp_equipment (location) where active;

create table if not exists public.temp_logs (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  kind text not null check (kind in ('equipment', 'receiving')),
  equipment_id uuid references public.temp_equipment(id),
  item text check (item is null or length(item) <= 80),
  supplier text check (supplier is null or length(supplier) <= 80),
  food text check (food is null or food in ('fridge', 'freezer', 'hot', 'chilled', 'frozen')),
  temp numeric(5,1) not null check (temp between -40 and 120),
  ok boolean not null,
  action text check (action is null or length(action) <= 200),
  recorded_by uuid not null references public.staff(id),
  recorded_at timestamptz not null default now(),
  check ((kind = 'equipment' and equipment_id is not null) or (kind = 'receiving' and item is not null))
);
create index if not exists temp_logs_location_idx on public.temp_logs (location, recorded_at desc);
-- Opening or closing check (equipment only).
alter table public.temp_logs add column if not exists slot text;
alter table public.temp_logs drop constraint if exists temp_logs_slot_check;
alter table public.temp_logs add constraint temp_logs_slot_check
  check ((kind = 'equipment' and slot in ('opening', 'closing')) or (kind = 'receiving' and slot is null)) not valid;

alter table public.temp_equipment enable row level security;
alter table public.temp_logs enable row level security;
revoke all on public.temp_equipment, public.temp_logs from anon, authenticated;

create or replace function public.mh_temp_ok(p_food text, p_temp numeric)
returns boolean language sql immutable set search_path to 'public'
as $function$
  select case when p_food in ('fridge', 'chilled') then p_temp <= 5
              when p_food in ('freezer', 'frozen') then p_temp <= -15
              when p_food = 'hot' then p_temp >= 60
              else false end
$function$;

create or replace function public.mh_temp_log_json(l public.temp_logs)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', l.id, 'kind', l.kind, 'equipment_id', l.equipment_id, 'slot', l.slot,
    'day', (l.recorded_at at time zone 'Australia/Brisbane')::date,
    'equipment', (select e.name from public.temp_equipment e where e.id = l.equipment_id),
    'item', l.item, 'supplier', l.supplier, 'food', l.food, 'temp', l.temp, 'ok', l.ok, 'action', l.action,
    'recorded_at', l.recorded_at, 'recorded_by', (select s.name from public.staff s where s.id = l.recorded_by))
$function$;

-- Today (Brisbane day): every piece of equipment with its opening and closing
-- check, today's records, and how many checks are still missing (closing
-- checks count as missing only from 2 pm).
create or replace function public.manager_temp_today(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_now timestamp := now() at time zone 'Australia/Brisbane';
  v_day date := v_now::date;
begin
  return (
    with eq as (
      select e.*,
        (select l from public.temp_logs l where l.equipment_id = e.id and l.slot = 'opening'
            and (l.recorded_at at time zone 'Australia/Brisbane')::date = v_day order by l.recorded_at desc limit 1) as op,
        (select l from public.temp_logs l where l.equipment_id = e.id and l.slot = 'closing'
            and (l.recorded_at at time zone 'Australia/Brisbane')::date = v_day order by l.recorded_at desc limit 1) as cl
        from public.temp_equipment e
       where e.location = mgr.location and e.active
    )
    select jsonb_build_object(
      'day', v_day,
      'equipment', coalesce((select jsonb_agg(jsonb_build_object(
          'id', eq.id, 'name', eq.name, 'kind', eq.kind,
          'opening', case when (eq.op).id is null then null else public.mh_temp_log_json(eq.op) end,
          'closing', case when (eq.cl).id is null then null else public.mh_temp_log_json(eq.cl) end)
          order by eq.created_at, lower(eq.name)) from eq), '[]'::jsonb),
      'missing', (select count(*) filter (where (eq.op).id is null)
                       + case when extract(hour from v_now) >= 14 then count(*) filter (where (eq.cl).id is null) else 0 end
                    from eq),
      'today', coalesce((select jsonb_agg(public.mh_temp_log_json(l) order by l.recorded_at desc)
                           from public.temp_logs l
                          where l.location = mgr.location
                            and (l.recorded_at at time zone 'Australia/Brisbane')::date = v_day), '[]'::jsonb)));
end $function$;

-- The weekly sheet: Monday p_start to Sunday. Equipment on the list (and any
-- removed one that has readings that week) and the latest reading of each
-- cell (equipment x day x opening/closing).
create or replace function public.manager_temp_week(p_manager_id uuid, p_start date)
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
      select l.* from public.temp_logs l
       where l.location = mgr.location and l.kind = 'equipment'
         and (l.recorded_at at time zone 'Australia/Brisbane')::date between v_start and v_start + 6
    ),
    latest as (
      select distinct on (equipment_id, (recorded_at at time zone 'Australia/Brisbane')::date, slot) *
        from logs
       order by equipment_id, (recorded_at at time zone 'Australia/Brisbane')::date, slot, recorded_at desc
    )
    select jsonb_build_object(
      'start', v_start, 'today', v_today, 'location', mgr.location,
      'equipment', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'kind', e.kind, 'active', e.active)
                                              order by e.created_at, lower(e.name))
                               from public.temp_equipment e
                              where e.location = mgr.location
                                and (e.active or exists (select 1 from logs where logs.equipment_id = e.id))), '[]'::jsonb),
      'cells', coalesce((select jsonb_agg(public.mh_temp_log_json(l)) from public.temp_logs l where l.id in (select id from latest)), '[]'::jsonb)));
end $function$;

-- Add or rename a piece of equipment, or take it off the list (active = false).
-- p_item: {id?, name, kind, active?}. Its past records are kept.
create or replace function public.manager_temp_equipment_save(p_manager_id uuid, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_name text := left(trim(coalesce(p_item->>'name', '')), 60);
  v_kind text := p_item->>'kind';
  v_active boolean := coalesce((p_item->>'active')::boolean, true);
  v_row public.temp_equipment%rowtype;
begin
  if p_item ? 'id' and p_item->>'id' is not null then
    update public.temp_equipment
       set name = case when v_name = '' then name else v_name end,
           kind = case when v_kind in ('fridge', 'freezer', 'hot') then v_kind else kind end,
           active = v_active
     where id = (p_item->>'id')::uuid and location = mgr.location
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    if v_name = '' or v_kind is null or v_kind not in ('fridge', 'freezer', 'hot') then raise exception 'INVALID_INPUT'; end if;
    insert into public.temp_equipment (location, name, kind, created_by)
    values (mgr.location, v_name, v_kind, p_manager_id)
    returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'kind', v_row.kind, 'active', v_row.active);
end $function$;

-- Save one reading. p_entry:
--   {kind: 'equipment', equipment_id, slot: 'opening' | 'closing', temp, action?}
--   {kind: 'receiving', item, supplier?, food: 'chilled' | 'frozen', temp, action?}
-- Outside the safe range the corrective action is required (ACTION_REQUIRED).
create or replace function public.manager_temp_record(p_manager_id uuid, p_entry jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_kind text := p_entry->>'kind';
  v_temp numeric;
  v_action text := nullif(left(trim(coalesce(p_entry->>'action', '')), 200), '');
  v_eq public.temp_equipment%rowtype;
  v_food text;
  v_item text;
  v_supplier text := nullif(left(trim(coalesce(p_entry->>'supplier', '')), 80), '');
  v_ok boolean;
  v_slot text := p_entry->>'slot';
  v_row public.temp_logs%rowtype;
begin
  begin
    v_temp := round((p_entry->>'temp')::numeric, 1);
  exception when others then raise exception 'INVALID_INPUT';
  end;
  if v_temp is null or v_temp < -40 or v_temp > 120 then raise exception 'INVALID_INPUT'; end if;
  if v_kind = 'equipment' then
    select * into v_eq from public.temp_equipment
     where id = (p_entry->>'equipment_id')::uuid and location = mgr.location and active;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
    if v_slot is null or v_slot not in ('opening', 'closing') then raise exception 'INVALID_INPUT'; end if;
    v_food := v_eq.kind;
  elsif v_kind = 'receiving' then
    v_item := nullif(left(trim(coalesce(p_entry->>'item', '')), 80), '');
    v_food := p_entry->>'food';
    if v_item is null or v_food is null or v_food not in ('chilled', 'frozen') then raise exception 'INVALID_INPUT'; end if;
    v_slot := null;
  else
    raise exception 'INVALID_INPUT';
  end if;
  v_ok := public.mh_temp_ok(v_food, v_temp);
  if not v_ok and v_action is null then raise exception 'ACTION_REQUIRED'; end if;
  insert into public.temp_logs (location, kind, equipment_id, slot, item, supplier, food, temp, ok, action, recorded_by)
  values (mgr.location, v_kind, v_eq.id, v_slot, v_item, case when v_kind = 'receiving' then v_supplier end, v_food, v_temp, v_ok, v_action, p_manager_id)
  returning * into v_row;
  return public.mh_temp_log_json(v_row);
end $function$;

-- Records of the last p_days days (1 to 120), newest first, for the council.
create or replace function public.manager_temp_history(p_manager_id uuid, p_days integer)
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
    'records', coalesce((select jsonb_agg(public.mh_temp_log_json(l) order by l.recorded_at desc)
                           from public.temp_logs l
                          where l.location = mgr.location and l.recorded_at > now() - make_interval(days => v_days)), '[]'::jsonb));
end $function$;

revoke all on function public.mh_temp_ok(text, numeric) from public, anon, authenticated;
revoke all on function public.mh_temp_log_json(public.temp_logs) from public, anon, authenticated;
revoke all on function public.manager_temp_today(uuid) from public, anon, authenticated;
revoke all on function public.manager_temp_week(uuid, date) from public, anon, authenticated;
revoke all on function public.manager_temp_equipment_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_temp_record(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_temp_history(uuid, integer) from public, anon, authenticated;
grant execute on function public.mh_temp_ok(text, numeric) to service_role;
grant execute on function public.mh_temp_log_json(public.temp_logs) to service_role;
grant execute on function public.manager_temp_today(uuid) to service_role;
grant execute on function public.manager_temp_week(uuid, date) to service_role;
grant execute on function public.manager_temp_equipment_save(uuid, jsonb) to service_role;
grant execute on function public.manager_temp_record(uuid, jsonb) to service_role;
grant execute on function public.manager_temp_history(uuid, integer) to service_role;
