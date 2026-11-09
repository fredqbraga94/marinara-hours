-- Notes: things to remember, written by the managers, in two separate lists,
-- Kitchen and Floor. The Kitchen Manager sees and writes only Kitchen notes,
-- the Floor Manager only Floor notes, the Administrator both (same rule as
-- Stock). A note can be pinned to the top, edited or removed. One list per
-- location and department.
-- Additive only: one new table and four new functions. Nothing existing changes.

create table if not exists public.manager_notes (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  department text not null check (department in ('Kitchen', 'Floor')),
  body text not null check (length(trim(body)) between 1 and 2000),
  pinned boolean not null default false,
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  updated_by uuid references public.staff(id),
  updated_at timestamptz
);
create index if not exists manager_notes_idx on public.manager_notes (location, department) where active;
alter table public.manager_notes enable row level security;
revoke all on public.manager_notes from anon, authenticated;

create or replace function public.mh_note_json(n public.manager_notes)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', n.id, 'department', n.department, 'body', n.body, 'pinned', n.pinned,
    'created_at', n.created_at, 'created_by', (select s.name from public.staff s where s.id = n.created_by),
    'updated_at', n.updated_at, 'updated_by', (select s.name from public.staff s where s.id = n.updated_by))
$function$;

-- The notes of one department: pinned first, then the newest.
create or replace function public.manager_note_list(p_manager_id uuid, p_department text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_dep text := public.mh_stock_department(mgr.role, p_department);
begin
  return jsonb_build_object(
    'location', mgr.location,
    'department', v_dep,
    'can_choose_department', public.mh_scope(mgr.role) is null,
    'notes', coalesce((
      select jsonb_agg(public.mh_note_json(n) order by n.pinned desc, coalesce(n.updated_at, n.created_at) desc)
        from public.manager_notes n where n.location = mgr.location and n.department = v_dep and n.active), '[]'::jsonb));
end $function$;

-- Add a note, or edit one. p_note: {id?, department, body, pinned?}.
create or replace function public.manager_note_save(p_manager_id uuid, p_note jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_dep text := public.mh_stock_department(mgr.role, p_note->>'department');
  v_body text := left(trim(coalesce(p_note->>'body', '')), 2000);
  v_id uuid := case when p_note ? 'id' and p_note->>'id' is not null then (p_note->>'id')::uuid end;
  v_row public.manager_notes%rowtype;
begin
  if v_body = '' then raise exception 'INVALID_INPUT'; end if;
  if v_id is not null then
    update public.manager_notes
       set body = v_body, pinned = coalesce((p_note->>'pinned')::boolean, pinned),
           updated_by = p_manager_id, updated_at = now()
     where id = v_id and location = mgr.location and department = v_dep and active
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    insert into public.manager_notes (location, department, body, pinned, created_by)
    values (mgr.location, v_dep, v_body, coalesce((p_note->>'pinned')::boolean, false), p_manager_id)
    returning * into v_row;
  end if;
  return public.mh_note_json(v_row);
exception
  when check_violation or invalid_text_representation then raise exception 'INVALID_INPUT';
end $function$;

-- Remove a note (kept in the table, hidden from the list). Only a note of a
-- department the manager can see.
create or replace function public.manager_note_remove(p_manager_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
begin
  update public.manager_notes set active = false, updated_by = p_manager_id, updated_at = now()
   where id = p_id and location = mgr.location and active and (v_scope is null or department = v_scope);
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  return jsonb_build_object('removed', true);
end $function$;

revoke all on function public.mh_note_json(public.manager_notes) from public, anon, authenticated;
revoke all on function public.manager_note_list(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_note_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_note_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mh_note_json(public.manager_notes) to service_role;
grant execute on function public.manager_note_list(uuid, text) to service_role;
grant execute on function public.manager_note_save(uuid, jsonb) to service_role;
grant execute on function public.manager_note_remove(uuid, uuid) to service_role;
