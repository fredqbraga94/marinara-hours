-- Permissions per manager. The Administrator chooses, for each Kitchen or Floor
-- Manager, which areas they can use: hours (approve, edit, add shifts,
-- timesheets), team, roster, time off, stock, recipes, invoices/prices/costs.
-- A manager without a row keeps exactly what their role gives today. A switch
-- can only take access away: role rules still apply (e.g. a Floor Manager never
-- sees invoices). The Administrator always has everything.
-- Every change is written to staff_audit (who changed what, when).
-- Additive only: one new table and four new functions. Nothing existing changes.

create table if not exists public.manager_permissions (
  staff_id uuid primary key references public.staff(id),
  hours boolean not null default true,
  team boolean not null default true,
  roster boolean not null default true,
  time_off boolean not null default true,
  stock boolean not null default true,
  recipes boolean not null default true,
  invoices boolean not null default true,
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now()
);

alter table public.manager_permissions enable row level security;
revoke all on public.manager_permissions from anon, authenticated;

-- The signed-in manager's own permissions (what the server checks on every
-- request). The Administrator, and anyone without a row, gets everything.
create or replace function public.manager_permissions_mine(p_manager_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
           'hours', coalesce(p.hours, true), 'team', coalesce(p.team, true),
           'roster', coalesce(p.roster, true), 'time_off', coalesce(p.time_off, true),
           'stock', coalesce(p.stock, true), 'recipes', coalesce(p.recipes, true),
           'invoices', coalesce(p.invoices, true))
    from (select 1) x
    left join public.manager_permissions p
      on p.staff_id = p_manager_id
     and not exists (select 1 from public.staff s where s.id = p_manager_id and s.role = 'manager')
$function$;

-- Permissions of every Kitchen/Floor Manager at the Administrator's location
-- (for the Team screen). Administrator only.
create or replace function public.manager_permissions_list(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_admin public.staff%rowtype;
begin
  select * into v_admin from public.staff where id = p_manager_id and active and role = 'manager';
  if not found then raise exception 'GM_REQUIRED'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'staff_id', s.id,
             'custom', p.staff_id is not null,
             'hours', coalesce(p.hours, true), 'team', coalesce(p.team, true),
             'roster', coalesce(p.roster, true), 'time_off', coalesce(p.time_off, true),
             'stock', coalesce(p.stock, true), 'recipes', coalesce(p.recipes, true),
             'invoices', coalesce(p.invoices, true)))
      from public.staff s
      left join public.manager_permissions p on p.staff_id = s.id
     where s.location = v_admin.location and s.role in ('kitchen_manager', 'floor_manager')
  ), '[]'::jsonb);
end $function$;

-- Set one manager's permissions. p_perms: {hours, team, roster, time_off,
-- stock, recipes, invoices} as true/false (missing keys keep their value).
-- Administrator only; the person must be a Kitchen or Floor Manager at the same
-- location.
create or replace function public.manager_permissions_set(p_manager_id uuid, p_staff_id uuid, p_perms jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin public.staff%rowtype;
  v_target public.staff%rowtype;
  v_old public.manager_permissions%rowtype;
  v_new public.manager_permissions%rowtype;
  v_key text;
begin
  select * into v_admin from public.staff where id = p_manager_id and active and role = 'manager';
  if not found then raise exception 'GM_REQUIRED'; end if;
  select * into v_target from public.staff where id = p_staff_id and location = v_admin.location;
  if not found or v_target.role not in ('kitchen_manager', 'floor_manager') then
    raise exception 'NOT_A_MANAGER';
  end if;
  if p_perms is null or jsonb_typeof(p_perms) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  for v_key in select jsonb_object_keys(p_perms) loop
    if v_key not in ('hours', 'team', 'roster', 'time_off', 'stock', 'recipes', 'invoices')
       or jsonb_typeof(p_perms -> v_key) <> 'boolean' then
      raise exception 'INVALID_INPUT';
    end if;
  end loop;

  select * into v_old from public.manager_permissions where staff_id = p_staff_id;
  insert into public.manager_permissions as m (staff_id, hours, team, roster, time_off, stock, recipes, invoices, updated_by, updated_at)
  values (p_staff_id,
          coalesce((p_perms->>'hours')::boolean, v_old.hours, true),
          coalesce((p_perms->>'team')::boolean, v_old.team, true),
          coalesce((p_perms->>'roster')::boolean, v_old.roster, true),
          coalesce((p_perms->>'time_off')::boolean, v_old.time_off, true),
          coalesce((p_perms->>'stock')::boolean, v_old.stock, true),
          coalesce((p_perms->>'recipes')::boolean, v_old.recipes, true),
          coalesce((p_perms->>'invoices')::boolean, v_old.invoices, true),
          p_manager_id, now())
  on conflict (staff_id) do update set
    hours = excluded.hours, team = excluded.team, roster = excluded.roster, time_off = excluded.time_off,
    stock = excluded.stock, recipes = excluded.recipes, invoices = excluded.invoices,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into v_new;

  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (p_staff_id, p_staff_id, p_manager_id, 'permissions',
          case when v_old.staff_id is null then null else to_jsonb(v_old) - 'updated_by' - 'updated_at' end,
          to_jsonb(v_new) - 'updated_by' - 'updated_at');

  return to_jsonb(v_new) - 'updated_by';
end $function$;

-- Edit a person and, in the same step, choose their access (used when someone
-- becomes a Kitchen or Floor Manager, so they never get more than chosen, even
-- for a moment). Both changes are saved together or not at all.
create or replace function public.manager_update_staff_with_access(
  p_manager_id uuid, p_staff_id uuid, p_name text, p_department text, p_new_pin text, p_role text, p_perms jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  if not exists (select 1 from public.staff where id = p_manager_id and active and role = 'manager') then
    raise exception 'GM_REQUIRED';
  end if;
  v_out := public.manager_update_staff_audited(p_manager_id, p_staff_id, p_name, p_department, p_new_pin, p_role);
  perform public.manager_permissions_set(p_manager_id, p_staff_id, p_perms);
  return v_out;
end $function$;

revoke all on function public.manager_permissions_mine(uuid) from public, anon, authenticated;
revoke all on function public.manager_permissions_list(uuid) from public, anon, authenticated;
revoke all on function public.manager_permissions_set(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_update_staff_with_access(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.manager_permissions_mine(uuid) to service_role;
grant execute on function public.manager_permissions_list(uuid) to service_role;
grant execute on function public.manager_permissions_set(uuid, uuid, jsonb) to service_role;
grant execute on function public.manager_update_staff_with_access(uuid, uuid, text, text, text, text, jsonb) to service_role;
