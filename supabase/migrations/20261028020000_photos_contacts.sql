-- Photos on Shopping and Maintenance items, and Maintenance contacts.
-- Photos: one photo per item (a new one replaces the old). The phone shrinks
-- it first: a small preview for the list and a larger copy opened on tap,
-- both JPEG kept here (no outside storage). Only for items of the manager's
-- own location.
-- Contacts: who does the repairs (Plumber, Oven, Electrician...), with name
-- and phone, so a manager can call straight from the app. Any manager can add,
-- edit or remove a contact. One list per location.
-- Additive: two new tables and new functions; the two list helpers for
-- Shopping and Maintenance (added the same week, 20261028000000 and
-- 20261028010000) now also return the photo preview.

create table if not exists public.item_photos (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  kind text not null check (kind in ('shopping', 'maintenance')),
  item_id uuid not null,
  thumb text not null check (thumb like 'data:image/jpeg;base64,%' and length(thumb) <= 40000),
  photo text not null check (photo like 'data:image/jpeg;base64,%' and length(photo) <= 700000),
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  unique (kind, item_id)
);
alter table public.item_photos enable row level security;
revoke all on public.item_photos from anon, authenticated;

create table if not exists public.maintenance_contacts (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  trade text not null check (length(trim(trade)) between 1 and 60),
  name text check (name is null or length(name) <= 80),
  phone text not null check (length(trim(phone)) between 3 and 30),
  note text check (note is null or length(note) <= 200),
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  updated_by uuid references public.staff(id),
  updated_at timestamptz
);
create index if not exists maintenance_contacts_location_idx on public.maintenance_contacts (location, trade) where active;
alter table public.maintenance_contacts enable row level security;
revoke all on public.maintenance_contacts from anon, authenticated;

-- The list helpers now carry the photo preview (null when there is none).
create or replace function public.mh_shopping_json(i public.shopping_items)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'name', i.name, 'qty', i.qty, 'note', i.note, 'urgent', i.urgent, 'status', i.status,
    'created_at', i.created_at, 'created_by', (select s.name from public.staff s where s.id = i.created_by),
    'done_at', i.done_at, 'done_by', (select s.name from public.staff s where s.id = i.done_by),
    'thumb', (select p.thumb from public.item_photos p where p.kind = 'shopping' and p.item_id = i.id))
$function$;

create or replace function public.mh_maintenance_json(i public.maintenance_items)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'equipment', i.equipment, 'problem', i.problem, 'urgent', i.urgent, 'status', i.status,
    'fix_note', i.fix_note,
    'created_at', i.created_at, 'created_by', (select s.name from public.staff s where s.id = i.created_by),
    'started_at', i.started_at, 'started_by', (select s.name from public.staff s where s.id = i.started_by),
    'done_at', i.done_at, 'done_by', (select s.name from public.staff s where s.id = i.done_by),
    'thumb', (select p.thumb from public.item_photos p where p.kind = 'maintenance' and p.item_id = i.id))
$function$;

-- The item must exist at the manager's location (and not be removed).
create or replace function public.mh_photo_item_ok(p_location text, p_kind text, p_item_id uuid)
returns boolean language sql stable set search_path to 'public'
as $function$
  select case p_kind
    when 'shopping' then exists (select 1 from public.shopping_items i where i.id = p_item_id and i.location = p_location and i.status <> 'removed')
    when 'maintenance' then exists (select 1 from public.maintenance_items i where i.id = p_item_id and i.location = p_location and i.status <> 'removed')
    else false end
$function$;

-- Add or replace the photo of an item.
create or replace function public.manager_photo_set(p_manager_id uuid, p_kind text, p_item_id uuid, p_thumb text, p_photo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  if p_kind not in ('shopping', 'maintenance') then raise exception 'INVALID_INPUT'; end if;
  if not public.mh_photo_item_ok(mgr.location, p_kind, p_item_id) then raise exception 'ITEM_NOT_FOUND'; end if;
  if p_thumb is null or p_photo is null
     or p_thumb not like 'data:image/jpeg;base64,%' or p_photo not like 'data:image/jpeg;base64,%'
     or length(p_thumb) > 40000 or length(p_photo) > 700000 then
    raise exception 'INVALID_INPUT';
  end if;
  insert into public.item_photos as x (location, kind, item_id, thumb, photo, created_by)
  values (mgr.location, p_kind, p_item_id, p_thumb, p_photo, p_manager_id)
  on conflict (kind, item_id) do update set thumb = excluded.thumb, photo = excluded.photo,
    created_by = excluded.created_by, created_at = now();
  return jsonb_build_object('thumb', p_thumb);
end $function$;

-- The larger copy of an item's photo (opened on tap).
create or replace function public.manager_photo_get(p_manager_id uuid, p_kind text, p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_photo text;
begin
  select p.photo into v_photo from public.item_photos p
   where p.kind = p_kind and p.item_id = p_item_id and p.location = mgr.location;
  if v_photo is null then raise exception 'ITEM_NOT_FOUND'; end if;
  return jsonb_build_object('photo', v_photo);
end $function$;

-- Remove the photo of an item.
create or replace function public.manager_photo_remove(p_manager_id uuid, p_kind text, p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  delete from public.item_photos p where p.kind = p_kind and p.item_id = p_item_id and p.location = mgr.location;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  return jsonb_build_object('removed', true);
end $function$;

create or replace function public.mh_contact_json(c public.maintenance_contacts)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object('id', c.id, 'trade', c.trade, 'name', c.name, 'phone', c.phone, 'note', c.note)
$function$;

-- Contacts of the manager's location, by trade.
create or replace function public.manager_contact_list(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  return jsonb_build_object('contacts', coalesce((
    select jsonb_agg(public.mh_contact_json(c) order by lower(c.trade), lower(coalesce(c.name, '')))
      from public.maintenance_contacts c where c.location = mgr.location and c.active), '[]'::jsonb));
end $function$;

-- Add a contact, or edit one. p_contact: {id?, trade, name, phone, note}.
create or replace function public.manager_contact_save(p_manager_id uuid, p_contact jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_trade text := left(trim(coalesce(p_contact->>'trade', '')), 60);
  v_name text := nullif(left(trim(coalesce(p_contact->>'name', '')), 80), '');
  v_phone text := left(trim(coalesce(p_contact->>'phone', '')), 30);
  v_note text := nullif(left(trim(coalesce(p_contact->>'note', '')), 200), '');
  v_row public.maintenance_contacts%rowtype;
begin
  if v_trade = '' or length(v_phone) < 3 or v_phone !~ '^[0-9+() .-]+$' then raise exception 'INVALID_INPUT'; end if;
  if p_contact ? 'id' and p_contact->>'id' is not null then
    update public.maintenance_contacts
       set trade = v_trade, name = v_name, phone = v_phone, note = v_note, updated_by = p_manager_id, updated_at = now()
     where id = (p_contact->>'id')::uuid and location = mgr.location and active
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    insert into public.maintenance_contacts (location, trade, name, phone, note, created_by)
    values (mgr.location, v_trade, v_name, v_phone, v_note, p_manager_id)
    returning * into v_row;
  end if;
  return public.mh_contact_json(v_row);
end $function$;

-- Remove a contact (kept in the table, hidden from the list).
create or replace function public.manager_contact_remove(p_manager_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  update public.maintenance_contacts set active = false, updated_by = p_manager_id, updated_at = now()
   where id = p_id and location = mgr.location and active;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  return jsonb_build_object('removed', true);
end $function$;

revoke all on function public.mh_photo_item_ok(text, text, uuid) from public, anon, authenticated;
revoke all on function public.manager_photo_set(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.manager_photo_get(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.manager_photo_remove(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.mh_contact_json(public.maintenance_contacts) from public, anon, authenticated;
revoke all on function public.manager_contact_list(uuid) from public, anon, authenticated;
revoke all on function public.manager_contact_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_contact_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mh_photo_item_ok(text, text, uuid) to service_role;
grant execute on function public.manager_photo_set(uuid, text, uuid, text, text) to service_role;
grant execute on function public.manager_photo_get(uuid, text, uuid) to service_role;
grant execute on function public.manager_photo_remove(uuid, text, uuid) to service_role;
grant execute on function public.mh_contact_json(public.maintenance_contacts) to service_role;
grant execute on function public.manager_contact_list(uuid) to service_role;
grant execute on function public.manager_contact_save(uuid, jsonb) to service_role;
grant execute on function public.manager_contact_remove(uuid, uuid) to service_role;
