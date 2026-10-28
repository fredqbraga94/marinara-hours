-- Rollback of 20261028020000_photos_contacts.sql (photos and contacts go away;
-- Shopping and Maintenance lists go back to no photo preview).
drop function if exists public.manager_contact_remove(uuid, uuid);
drop function if exists public.manager_contact_save(uuid, jsonb);
drop function if exists public.manager_contact_list(uuid);
drop function if exists public.mh_contact_json(public.maintenance_contacts);
drop function if exists public.manager_photo_remove(uuid, text, uuid);
drop function if exists public.manager_photo_get(uuid, text, uuid);
drop function if exists public.manager_photo_set(uuid, text, uuid, text, text);
drop function if exists public.mh_photo_item_ok(text, text, uuid);

create or replace function public.mh_shopping_json(i public.shopping_items)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'name', i.name, 'qty', i.qty, 'note', i.note, 'urgent', i.urgent, 'status', i.status,
    'created_at', i.created_at, 'created_by', (select s.name from public.staff s where s.id = i.created_by),
    'done_at', i.done_at, 'done_by', (select s.name from public.staff s where s.id = i.done_by))
$function$;

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

drop table if exists public.maintenance_contacts;
drop table if exists public.item_photos;
