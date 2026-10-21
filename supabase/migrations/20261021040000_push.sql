-- Phone notifications (Web Push) for managers, e.g. "Noah asked for a holiday".
-- A manager turns notifications on in the app on their own phone; that phone's
-- push address is stored here. The restaurant tablet never subscribes, so it
-- never gets them. The Administrator can see and turn off any subscribed phone.
-- Additive only: one new table and new functions. Nothing existing changes.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id),
  location text not null,
  endpoint text not null unique check (length(endpoint) <= 1000 and endpoint like 'https://%'),
  p256dh text not null check (length(p256dh) between 40 and 200),
  auth text not null check (length(auth) between 10 and 60),
  device_label text check (device_label is null or length(device_label) <= 80),
  active boolean not null default true,
  failures integer not null default 0,
  last_error text,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_place_idx on public.push_subscriptions (location, active);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create or replace function public.mh_push_json(p public.push_subscriptions)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', p.id, 'staff_id', p.staff_id,
    'staff_name', (select name from public.staff where id = p.staff_id),
    'staff_role', (select role from public.staff where id = p.staff_id),
    'device_label', p.device_label, 'active', p.active,
    'last_sent_at', p.last_sent_at, 'created_at', p.created_at)
$function$;

-- Turn notifications on for this phone (signed in as p_manager_id).
create or replace function public.manager_push_subscribe(
  p_manager_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_row public.push_subscriptions%rowtype;
begin
  if p_endpoint is null or p_p256dh is null or p_auth is null then raise exception 'INVALID_INPUT'; end if;
  insert into public.push_subscriptions (staff_id, location, endpoint, p256dh, auth, device_label)
  values (mgr.id, coalesce(mgr.location, 'Hawthorne'), p_endpoint, p_p256dh, p_auth,
          nullif(left(trim(coalesce(p_label, '')), 80), ''))
  on conflict (endpoint) do update
    set staff_id = excluded.staff_id, location = excluded.location,
        p256dh = excluded.p256dh, auth = excluded.auth,
        device_label = coalesce(excluded.device_label, public.push_subscriptions.device_label),
        active = true, failures = 0, last_error = null, updated_at = now()
  returning * into v_row;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (mgr.id, mgr.id, mgr.id, 'manager_push_subscribe', null,
          jsonb_build_object('subscription', v_row.id, 'device_label', v_row.device_label));
  return public.mh_push_json(v_row);
exception
  when check_violation then raise exception 'INVALID_INPUT';
end $function$;

-- Turn notifications off for this phone.
create or replace function public.manager_push_unsubscribe(p_manager_id uuid, p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_n integer;
begin
  update public.push_subscriptions set active = false, updated_at = now()
   where endpoint = p_endpoint and (staff_id = mgr.id or mgr.role in ('manager', 'admin'));
  get diagnostics v_n = row_count;
  return jsonb_build_object('turned_off', v_n);
end $function$;

-- Phones that receive notifications. Administrator: all in the unit; other
-- managers: only their own.
create or replace function public.manager_push_list(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  return coalesce((
    select jsonb_agg(public.mh_push_json(p) order by p.created_at)
      from public.push_subscriptions p
     where p.active and p.location = coalesce(mgr.location, 'Hawthorne')
       and (mgr.role in ('manager', 'admin') or p.staff_id = mgr.id)
  ), '[]'::jsonb);
end $function$;

-- Administrator turns off notifications for any phone.
create or replace function public.manager_push_remove(p_manager_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_n integer;
begin
  if mgr.role not in ('manager', 'admin') then raise exception 'GM_REQUIRED'; end if;
  update public.push_subscriptions set active = false, updated_at = now()
   where id = p_id and location = coalesce(mgr.location, 'Hawthorne') and active;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'DEVICE_NOT_FOUND'; end if;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (null, mgr.id, mgr.id, 'manager_push_remove', jsonb_build_object('subscription', p_id), null);
  return jsonb_build_object('id', p_id, 'active', false);
end $function$;

-- Who gets a notification about a department in a unit: the Administrator
-- account(s) and the manager of that department, on every phone they turned on.
create or replace function public.mh_push_targets(p_location text, p_department text)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.id, p.endpoint, p.p256dh, p.auth
    from public.push_subscriptions p
    join public.staff s on s.id = p.staff_id
   where p.active and s.active and p.location = p_location
     and (s.role in ('manager', 'admin')
          or (s.role = 'kitchen_manager' and p_department = 'Kitchen')
          or (s.role = 'floor_manager' and p_department = 'Floor'))
$function$;

-- One manager's own phones (for "Send a test").
create or replace function public.mh_push_for_staff(p_staff_id uuid)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.id, p.endpoint, p.p256dh, p.auth
    from public.push_subscriptions p
   where p.active and p.staff_id = p_staff_id
$function$;

-- Result of one send. A phone that is gone (404/410) or keeps failing is
-- turned off automatically.
create or replace function public.mh_push_result(p_id uuid, p_ok boolean, p_gone boolean, p_error text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update public.push_subscriptions
     set last_sent_at = case when p_ok then now() else last_sent_at end,
         failures = case when p_ok then 0 else failures + 1 end,
         last_error = case when p_ok then null else left(p_error, 200) end,
         active = case when p_gone or (not p_ok and failures + 1 >= 5) then false else active end,
         updated_at = now()
   where id = p_id
$function$;

revoke all on function public.mh_push_json(public.push_subscriptions) from public, anon, authenticated;
revoke all on function public.manager_push_subscribe(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.manager_push_unsubscribe(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_push_list(uuid) from public, anon, authenticated;
revoke all on function public.manager_push_remove(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mh_push_targets(text, text) from public, anon, authenticated;
revoke all on function public.mh_push_result(uuid, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.mh_push_for_staff(uuid) from public, anon, authenticated;
grant execute on function public.mh_push_for_staff(uuid) to service_role;
grant execute on function public.manager_push_subscribe(uuid, text, text, text, text) to service_role;
grant execute on function public.manager_push_unsubscribe(uuid, text) to service_role;
grant execute on function public.manager_push_list(uuid) to service_role;
grant execute on function public.manager_push_remove(uuid, uuid) to service_role;
grant execute on function public.mh_push_targets(text, text) to service_role;
grant execute on function public.mh_push_result(uuid, boolean, boolean, text) to service_role;
