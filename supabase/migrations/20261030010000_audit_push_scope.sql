-- Scope notifications to the home restaurant, independent of Administrator unit view.
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
  -- Viewing another unit must not move personal notification administration.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  if p_endpoint is null or p_p256dh is null or p_auth is null then raise exception 'INVALID_INPUT'; end if;
  insert into public.push_subscriptions (staff_id, location, endpoint, p256dh, auth, device_label)
  values (mgr.id, coalesce(mgr.location, 'Hawthorne'), p_endpoint, p_p256dh, p_auth,
          nullif(left(trim(coalesce(p_label, '')), 80), ''))
  on conflict (endpoint) do update
    set staff_id = excluded.staff_id, location = excluded.location,
        p256dh = excluded.p256dh, auth = excluded.auth,
        device_label = coalesce(excluded.device_label, public.push_subscriptions.device_label),
        active = true, failures = 0, last_error = null, updated_at = now()
    where public.push_subscriptions.location = excluded.location
  returning * into v_row;
  if v_row.id is null then raise exception 'NOT_ALLOWED'; end if;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (mgr.id, mgr.id, mgr.id, 'manager_push_subscribe', null,
          jsonb_build_object('subscription', v_row.id, 'device_label', v_row.device_label));
  return public.mh_push_json(v_row);
exception
  when check_violation then raise exception 'INVALID_INPUT';
end $function$;

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
  -- Viewing another unit must not move personal notification administration.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  update public.push_subscriptions set active = false, updated_at = now()
   where endpoint = p_endpoint and location = coalesce(mgr.location, 'Hawthorne') and (staff_id = mgr.id or mgr.role in ('manager', 'admin'));
  get diagnostics v_n = row_count;
  return jsonb_build_object('turned_off', v_n);
end $function$;

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
  -- Viewing another unit must not move personal notification administration.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  return coalesce((
    select jsonb_agg(public.mh_push_json(p) order by p.created_at)
      from public.push_subscriptions p
     where p.active and p.location = coalesce(mgr.location, 'Hawthorne')
       and (mgr.role in ('manager', 'admin') or p.staff_id = mgr.id)
  ), '[]'::jsonb);
end $function$;

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
  -- Viewing another unit must not move personal notification administration.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  if mgr.role not in ('manager', 'admin') then raise exception 'GM_REQUIRED'; end if;
  update public.push_subscriptions set active = false, updated_at = now()
   where id = p_id and location = coalesce(mgr.location, 'Hawthorne') and active;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'DEVICE_NOT_FOUND'; end if;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (null, mgr.id, mgr.id, 'manager_push_remove', jsonb_build_object('subscription', p_id), null);
  return jsonb_build_object('id', p_id, 'active', false);
end $function$;
revoke all on function public.manager_push_subscribe(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.manager_push_subscribe(uuid,text,text,text,text) to service_role;
revoke all on function public.manager_push_unsubscribe(uuid,text) from public, anon, authenticated;
grant execute on function public.manager_push_unsubscribe(uuid,text) to service_role;
revoke all on function public.manager_push_list(uuid) from public, anon, authenticated;
grant execute on function public.manager_push_list(uuid) to service_role;
revoke all on function public.manager_push_remove(uuid,uuid) from public, anon, authenticated;
grant execute on function public.manager_push_remove(uuid,uuid) to service_role;
