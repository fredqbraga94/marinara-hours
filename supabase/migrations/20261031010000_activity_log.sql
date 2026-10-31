-- Activity: who changed what and when, in one list, for the Administrator only.
-- Read only: it puts together what the app already records (hours, team,
-- roster, time off, stock, kitchen, invoices, devices, temperatures, deliveries,
-- food temperatures, cleaning, shopping, maintenance). Nothing can be changed or
-- deleted from here. One unit at a time (the unit the Administrator looks at):
-- a change belongs to the unit of the person or thing it is about, otherwise to
-- the unit of who made it.
-- Additive only: four new functions. Nothing existing changes.

create or replace function public.mh_act_name(p_id uuid)
returns text language sql stable set search_path to 'public'
as $function$ select s.name from public.staff s where s.id = p_id $function$;

create or replace function public.mh_act_loc(p_id uuid)
returns text language sql stable set search_path to 'public'
as $function$ select s.location from public.staff s where s.id = p_id $function$;

-- "Sat 31 Oct 9:00–17:30" in Brisbane time.
create or replace function public.mh_act_span(p_in text, p_out text)
returns text language sql stable set search_path to 'public'
as $function$
  select case when p_in is null then '' else
    to_char(p_in::timestamptz at time zone 'Australia/Brisbane', 'Dy DD Mon HH24:MI') || '–' ||
    coalesce(to_char(p_out::timestamptz at time zone 'Australia/Brisbane', 'HH24:MI'), '…') end
$function$;

-- The list. p_days: 1 to 90 (default 7). p_who: only what this person did.
-- Newest first, at most 500 rows.
create or replace function public.manager_activity(p_manager_id uuid, p_days integer, p_who uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_days integer := greatest(1, least(coalesce(p_days, 7), 90));
  v_from timestamptz := now() - make_interval(days => v_days);
begin
  if mgr.role <> 'manager' then raise exception 'GM_REQUIRED'; end if;
  return (
  with rows as (
    -- Hours
    select a.changed_at as at, a.changed_by as who, 'Hours' as area,
           coalesce(public.mh_act_loc((s->>'staff_id')::uuid), public.mh_act_loc(a.changed_by)) as loc,
           case a.action
             when 'manager_approve_shift' then 'Approved hours'
             when 'manager_create_shift' then 'Added a shift'
             when 'manager_delete_shift' then 'Deleted a shift'
             when 'manager_edit_shift' then 'Edited a shift'
             when 'manager_reopen_shift' then 'Reopened a shift'
             else 'Changed a shift' end
           || ': ' || coalesce(public.mh_act_name((s->>'staff_id')::uuid), 'someone') || ' · ' || public.mh_act_span(s->>'clock_in', s->>'clock_out')
           || case when a.action = 'manager_edit_shift' and o is not null
                    and public.mh_act_span(o->>'clock_in', o->>'clock_out') <> public.mh_act_span(s->>'clock_in', s->>'clock_out')
                   then ' (was ' || public.mh_act_span(o->>'clock_in', o->>'clock_out') || ')' else '' end as what
      from public.shift_audit a,
           lateral (select coalesce(a.new_data->'shift', a.new_data->'deleted', a.old_data->'shift', a.new_data, a.old_data) as s,
                           coalesce(a.old_data->'shift', a.old_data) as o) x
     where a.changed_at > v_from and a.changed_by is not null and jsonb_typeof(x.s) = 'object'
    union all
    -- Team, invoices, notifications, access
    select a.changed_at, a.changed_by,
           case when a.action like 'manager_invoice_%' then 'Finance'
                when a.action = 'manager_push_subscribe' then 'Devices' else 'Team' end,
           coalesce(n->>'location', public.mh_act_loc(a.staff_id), public.mh_act_loc(a.changed_by)),
           case a.action
             when 'manager_create_staff' then 'Added ' || coalesce(n->>'name', '') || ' to the team'
             when 'manager_activate_staff' then 'Made ' || coalesce(n->>'name', '') || ' active again'
             when 'manager_deactivate_staff' then 'Made ' || coalesce(n->>'name', '') || ' inactive'
             when 'manager_update_staff' then 'Updated ' || coalesce(n->>'name', '') ||
               coalesce(': ' || (select string_agg(k, ', ' order by k) from jsonb_object_keys(n) k
                                  where k not in ('pin_conflict_at', 'pin_changed', 'id')
                                    and a.old_data is not null and (a.old_data->k) is distinct from (n->k)), '') ||
               case when (n->>'pin_changed')::boolean then ' (PIN reset)' else '' end
             when 'manager_set_roster_info' then 'Roster details for ' || coalesce(n->>'name', '')
             when 'manager_set_student_visa' then 'Student visa for ' || coalesce(n->>'name', '') || ': ' ||
               case when (n->>'student_visa')::boolean then 'on' else 'off' end
             when 'manager_set_roster_order' then 'Changed the roster order'
             when 'manager_push_subscribe' then 'Turned on notifications on ' || coalesce(nullif(n->>'device_label', ''), 'a phone')
             when 'manager_invoice_save' then 'Saved invoice ' || coalesce(n->>'supplier', '') || coalesce(' #' || (n->>'number'), '') || coalesce(' · A$' || (n->>'total'), '')
             when 'manager_invoice_remove' then 'Removed invoice ' || coalesce(n->>'supplier', '') || coalesce(' #' || (n->>'number'), '') || coalesce(' · A$' || (n->>'total'), '')
             when 'permissions' then 'Changed what ' || coalesce(public.mh_act_name(coalesce((n->>'staff_id')::uuid, a.staff_id)), 'a manager') || ' can see'
             else initcap(replace(replace(coalesce(a.action, 'change'), 'manager_', ''), '_', ' ')) end
      from public.staff_audit a, lateral (select coalesce(a.new_data, a.old_data, '{}'::jsonb) as n) x
     where a.changed_at > v_from and a.changed_by is not null and coalesce(a.action, '') <> 'manager_unit_set'
    union all
    -- Roster
    select r.changed_at, r.changed_by, 'Roster', coalesce(public.mh_act_loc(r.staff_ref), public.mh_act_loc(r.changed_by)),
           'Roster ' || coalesce(public.mh_act_name(r.staff_ref), 'someone') || ' · ' || to_char(r.work_date, 'Dy DD Mon') || ': ' ||
           coalesce(nullif(trim(coalesce(r.old_code, '') || ' ' || coalesce(r.old_times, '')), ''), 'off') || ' → ' ||
           coalesce(nullif(trim(coalesce(r.new_code, '') || ' ' || coalesce(r.new_times, '')), ''), 'off')
      from public.roster_audit r where r.changed_at > v_from and r.changed_by is not null
    union all
    -- Time off: decided, or added by a manager
    select l.decided_at, l.decided_by, 'Time off', public.mh_act_loc(l.staff_id),
           case l.status when 'APPROVED' then 'Approved' when 'DECLINED' then 'Declined' when 'CANCELLED' then 'Cancelled' else 'Changed' end
           || ' time off: ' || coalesce(public.mh_act_name(l.staff_id), '') || ' · ' || to_char(l.start_date, 'DD Mon') ||
           case when l.end_date <> l.start_date then '–' || to_char(l.end_date, 'DD Mon') else '' end
      from public.leave_requests l where l.decided_at > v_from and l.decided_by is not null
    union all
    select l.created_at, l.requested_by, 'Time off', public.mh_act_loc(l.staff_id),
           'Added time off for ' || coalesce(public.mh_act_name(l.staff_id), '') || ' · ' || to_char(l.start_date, 'DD Mon') ||
           case when l.end_date <> l.start_date then '–' || to_char(l.end_date, 'DD Mon') else '' end
      from public.leave_requests l where l.created_at > v_from and l.requested_by is not null and l.requested_by <> l.staff_id
    union all
    -- Stock
    select a.changed_at, a.changed_by, 'Stock',
           coalesce(a.new_value->>'location', a.old_value->>'location', nullif(split_part(a.ref, '/', 1), ''), public.mh_act_loc(a.changed_by)),
           case a.kind
             when 'item' then case when a.old_value is null then 'Added stock item ' else 'Changed stock item ' end || coalesce(a.new_value->>'name', '')
             when 'item_removed' then 'Removed stock item ' || coalesce(a.old_value->>'name', '')
             when 'supplier' then 'Supplier ' || split_part(a.ref, '/', 3)
             when 'supplier_rename' then 'Renamed supplier ' || coalesce(a.old_value->>'name', '') || ' → ' || coalesce(a.new_value->>'name', '')
             else initcap(replace(a.kind, '_', ' ')) end
      from public.stock_audit a where a.changed_at > v_from and a.changed_by is not null
    union all
    select c.counted_at, c.counted_by, 'Stock', c.location, 'Stock count · ' || c.department
      from public.stock_counts c where c.counted_at > v_from and c.counted_by is not null
    union all
    select c.closed_at, c.closed_by, 'Stock', c.location, 'Closed the stock order · ' || c.department
      from public.stock_counts c where c.closed_at > v_from and c.closed_by is not null
    union all
    -- Kitchen (recipes and ingredients)
    select a.changed_at, a.changed_by, 'Kitchen', public.mh_act_loc(a.changed_by),
           case a.kind
             when 'recipe_save' then case when a.old_value is null then 'Added recipe ' else 'Changed recipe ' end
             when 'recipe_remove' then 'Removed recipe '
             when 'ingredient_save' then 'Changed ingredient '
             when 'ingredient_cost' then 'Changed the cost of '
             when 'made_here' then 'Marked as made here: '
             else initcap(replace(a.kind, '_', ' ')) || ' ' end || coalesce(a.new_value->>'name', a.old_value->>'name', '')
      from public.recipe_audit a where a.changed_at > v_from and a.changed_by is not null
    union all
    -- Devices
    select e.at, e.manager_id, 'Devices',
           coalesce(d.management_location, public.mh_act_loc(e.manager_id)),
           case e.event
             when 'device_approved' then 'Approved a device'
             when 'device_revoked' then 'Removed a device'
             when 'device_unlocked' then 'Unlocked a device'
             when 'device_renamed' then 'Renamed a device'
             when 'mode_changed' then 'Changed the device mode'
             when 'pairing_code_created' then 'Made a device code'
             else initcap(replace(e.event, '_', ' ')) end || coalesce(' · ' || nullif(d.label, ''), '')
      from public.auth_events e left join public.auth_devices d on d.id = e.device_id
     where e.at > v_from and e.manager_id is not null
    union all
    -- Temperatures and deliveries
    select t.recorded_at, t.recorded_by, 'Food safety', t.location,
           case when t.kind = 'equipment'
                then 'Temperature ' || coalesce((select q.name from public.temp_equipment q where q.id = t.equipment_id), '') || ' · ' || initcap(coalesce(t.slot, ''))
                else 'Delivery ' || coalesce(t.item, '') || coalesce(' (' || t.supplier || ')', '') end
           || ': ' || t.temp || '°C' || case when t.ok then '' else ' (out of range)' end
           || case when t.checked_by is not null and t.checked_by <> t.recorded_by then ' · checked by ' || coalesce(public.mh_act_name(t.checked_by), '') else '' end
      from public.temp_logs t where t.recorded_at > v_from
    union all
    select t.edited_at, t.edited_by, 'Food safety', t.location,
           'Corrected delivery ' || coalesce(t.item, '') || ': ' || t.temp || '°C (was ' || coalesce(t.original->>'temp', '?') || '°C' ||
           case when (t.original->>'item') is distinct from t.item then ', ' || coalesce(t.original->>'item', '') else '' end || ')'
      from public.temp_logs t where t.edited_at > v_from and t.edited_by is not null
    union all
    select f.recorded_at, f.recorded_by, 'Food safety', f.location,
           'Food temperature ' || f.food || ' · ' ||
           case f.check_type when 'cook' then 'Cooking' when 'reheat' then 'Reheating' when 'hot' then 'Hot holding'
                             when 'cold' then 'Cold holding' else case f.stage when 0 then 'Cooling start' when 1 then 'Cooling 2 h' else 'Cooling 6 h' end end
           || ': ' || f.temp || '°C' || case when f.ok then '' else ' (out of range)' end
           || case when f.checked_by is not null and f.checked_by <> f.recorded_by then ' · checked by ' || coalesce(public.mh_act_name(f.checked_by), '') else '' end
      from public.food_temps f where f.recorded_at > v_from
    union all
    select f.edited_at, f.edited_by, 'Food safety', f.location,
           'Corrected food temperature ' || f.food || ': ' || f.temp || '°C (was ' || coalesce(f.original->>'temp', '?') || '°C' ||
           case when (f.original->>'food') is distinct from f.food then ', ' || coalesce(f.original->>'food', '') else '' end || ')'
      from public.food_temps f where f.edited_at > v_from and f.edited_by is not null
    union all
    select c.recorded_at, c.recorded_by, 'Food safety', c.location,
           'Cleaning done: ' || coalesce((select k.name from public.cleaning_tasks k where k.id = c.task_id), '') || ' · ' || to_char(c.day, 'Dy DD Mon')
           || case when c.done_by <> c.recorded_by then ' · by ' || coalesce(public.mh_act_name(c.done_by), '') else '' end
      from public.cleaning_logs c where c.recorded_at > v_from
    union all
    -- Shopping and maintenance
    select s.created_at, s.created_by, 'Shopping', s.location, 'Added to shopping: ' || s.name || case when s.urgent then ' (urgent)' else '' end
      from public.shopping_items s where s.created_at > v_from and s.created_by is not null
    union all
    select s.done_at, s.done_by, 'Shopping', s.location, case s.status when 'removed' then 'Removed from shopping: ' else 'Bought: ' end || s.name
      from public.shopping_items s where s.done_at > v_from and s.done_by is not null
    union all
    select m.created_at, m.created_by, 'Maintenance', m.location, 'Reported: ' || m.equipment || ' · ' || m.problem || case when m.urgent then ' (urgent)' else '' end
      from public.maintenance_items m where m.created_at > v_from and m.created_by is not null
    union all
    select m.started_at, m.started_by, 'Maintenance', m.location, 'Started fixing: ' || m.equipment
      from public.maintenance_items m where m.started_at > v_from and m.started_by is not null
    union all
    select m.done_at, m.done_by, 'Maintenance', m.location,
           case m.status when 'removed' then 'Removed: ' else 'Fixed: ' end || m.equipment || coalesce(' · ' || nullif(m.fix_note, ''), '')
      from public.maintenance_items m where m.done_at > v_from and m.done_by is not null
  ),
  here as (select * from rows where loc = mgr.location)
  select jsonb_build_object(
    'location', mgr.location, 'days', v_days,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.who, 'name', p.name) order by lower(p.name))
                          from (select distinct h.who, public.mh_act_name(h.who) as name from here h) p where p.name is not null), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('at', i.at, 'who_id', i.who, 'who', public.mh_act_name(i.who), 'area', i.area, 'what', i.what) order by i.at desc)
                         from (select * from here h where p_who is null or h.who = p_who order by h.at desc limit 500) i), '[]'::jsonb),
    'more', (select count(*) from here h where p_who is null or h.who = p_who) > 500));
end $function$;

revoke all on function public.mh_act_name(uuid) from public, anon, authenticated;
revoke all on function public.mh_act_loc(uuid) from public, anon, authenticated;
revoke all on function public.mh_act_span(text, text) from public, anon, authenticated;
revoke all on function public.manager_activity(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.mh_act_name(uuid) to service_role;
grant execute on function public.mh_act_loc(uuid) to service_role;
grant execute on function public.mh_act_span(text, text) to service_role;
grant execute on function public.manager_activity(uuid, integer, uuid) to service_role;
