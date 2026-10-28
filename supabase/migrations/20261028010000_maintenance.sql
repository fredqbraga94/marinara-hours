-- Maintenance: equipment that is broken or needs fixing (the oven, a light in
-- the cool room). Any manager (Administrator, Kitchen or Floor Manager) can
-- report a problem, mark it "being fixed", mark it fixed (with a note of what
-- was done), reopen it, or remove it. The list keeps who reported it, who
-- fixed it and when. One list per location.
-- Additive only: one new table and four new functions. Nothing existing changes.

create table if not exists public.maintenance_items (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  equipment text not null check (length(trim(equipment)) between 1 and 80),
  problem text check (problem is null or length(problem) <= 300),
  urgent boolean not null default false,
  status text not null default 'open' check (status in ('open', 'in_progress', 'fixed', 'removed')),
  fix_note text check (fix_note is null or length(fix_note) <= 300),
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  started_by uuid references public.staff(id),
  started_at timestamptz,
  done_by uuid references public.staff(id),
  done_at timestamptz
);
create index if not exists maintenance_items_location_idx on public.maintenance_items (location, status, created_at);

alter table public.maintenance_items enable row level security;
revoke all on public.maintenance_items from anon, authenticated;

create or replace function public.mh_maintenance_json(i public.maintenance_items)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'equipment', i.equipment, 'problem', i.problem, 'urgent', i.urgent, 'status', i.status,
    'fix_note', i.fix_note,
    'created_at', i.created_at, 'created_by', (select s.name from public.staff s where s.id = i.created_by),
    'started_at', i.started_at, 'started_by', (select s.name from public.staff s where s.id = i.started_by),
    'done_at', i.done_at, 'done_by', (select s.name from public.staff s where s.id = i.done_by))
$function$;

-- Problems still open (urgent first), plus what was fixed in the last 30 days.
create or replace function public.manager_maintenance_list(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  return jsonb_build_object(
    'open', coalesce((select jsonb_agg(public.mh_maintenance_json(i) order by i.urgent desc, i.created_at)
                        from public.maintenance_items i
                       where i.location = mgr.location and i.status in ('open', 'in_progress')), '[]'::jsonb),
    'fixed', coalesce((select jsonb_agg(public.mh_maintenance_json(i) order by i.done_at desc)
                         from public.maintenance_items i
                        where i.location = mgr.location and i.status = 'fixed' and i.done_at > now() - interval '30 days'), '[]'::jsonb));
end $function$;

-- Report a problem, or edit one not fixed yet. p_item: {id?, equipment, problem, urgent}.
create or replace function public.manager_maintenance_save(p_manager_id uuid, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_equipment text := left(trim(coalesce(p_item->>'equipment', '')), 80);
  v_problem text := nullif(left(trim(coalesce(p_item->>'problem', '')), 300), '');
  v_urgent boolean := coalesce((p_item->>'urgent')::boolean, false);
  v_row public.maintenance_items%rowtype;
begin
  if v_equipment = '' then raise exception 'INVALID_INPUT'; end if;
  if p_item ? 'id' and p_item->>'id' is not null then
    update public.maintenance_items
       set equipment = v_equipment, problem = v_problem, urgent = v_urgent
     where id = (p_item->>'id')::uuid and location = mgr.location and status in ('open', 'in_progress')
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    insert into public.maintenance_items (location, equipment, problem, urgent, created_by)
    values (mgr.location, v_equipment, v_problem, v_urgent, p_manager_id)
    returning * into v_row;
  end if;
  return public.mh_maintenance_json(v_row);
end $function$;

-- Change the status. p_status: open | in_progress | fixed | removed.
-- p_note: what was done (kept when marked fixed).
create or replace function public.manager_maintenance_mark(p_manager_id uuid, p_id uuid, p_status text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_note text := nullif(left(trim(coalesce(p_note, '')), 300), '');
  v_row public.maintenance_items%rowtype;
begin
  if p_status not in ('open', 'in_progress', 'fixed', 'removed') then raise exception 'INVALID_INPUT'; end if;
  update public.maintenance_items
     set status = p_status,
         started_by = case when p_status = 'in_progress' then p_manager_id when p_status = 'open' then null else started_by end,
         started_at = case when p_status = 'in_progress' then now() when p_status = 'open' then null else started_at end,
         done_by = case when p_status in ('fixed', 'removed') then p_manager_id else null end,
         done_at = case when p_status in ('fixed', 'removed') then now() else null end,
         fix_note = case when p_status = 'fixed' then v_note when p_status = 'removed' then fix_note else null end
   where id = p_id and location = mgr.location and status <> 'removed'
  returning * into v_row;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  return public.mh_maintenance_json(v_row);
end $function$;

revoke all on function public.mh_maintenance_json(public.maintenance_items) from public, anon, authenticated;
revoke all on function public.manager_maintenance_list(uuid) from public, anon, authenticated;
revoke all on function public.manager_maintenance_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_maintenance_mark(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.mh_maintenance_json(public.maintenance_items) to service_role;
grant execute on function public.manager_maintenance_list(uuid) to service_role;
grant execute on function public.manager_maintenance_save(uuid, jsonb) to service_role;
grant execute on function public.manager_maintenance_mark(uuid, uuid, text, text) to service_role;
