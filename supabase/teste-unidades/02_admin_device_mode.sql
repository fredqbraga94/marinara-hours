CREATE OR REPLACE FUNCTION public.auth_set_mode(p_manager_id uuid, p_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_old text;
begin
  if mgr.role not in ('manager', 'admin') then raise exception 'GM_REQUIRED'; end if;
  if p_mode not in ('grace', 'enforce') then raise exception 'INVALID_INPUT'; end if;
  select device_mode into v_old from public.auth_settings where id for update;
  update public.auth_settings set device_mode = p_mode, updated_at = now(), updated_by = mgr.id where id;
  insert into public.auth_events (event, manager_id, detail)
  values ('mode_changed', mgr.id, jsonb_build_object('from', v_old, 'to', p_mode));
  return jsonb_build_object('mode', p_mode);
end $function$
;

CREATE OR REPLACE FUNCTION public.auth_list_devices(p_manager_id uuid, p_current_device_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  cfg public.auth_settings%rowtype;
begin
  select * into cfg from public.auth_settings where id;
  return jsonb_build_object(
    'mode', cfg.device_mode,
    'can_change_mode', mgr.role in ('manager', 'admin'),
    'unknown_locked_until', (select locked_until from public.auth_attempt_buckets where bucket = 'unknown' and locked_until > now()),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', d.label, 'status', d.status, 'approved_via', d.approved_via,
        'approved_at', d.approved_at, 'approved_by', ab.name, 'last_seen_at', d.last_seen_at,
        'last_staff', ls.name, 'revoked_at', d.revoked_at,
        'locked_until', (select locked_until from public.auth_attempt_buckets bk
                          where bk.bucket = 'device:' || d.id and bk.locked_until > now()),
        'is_current', d.device_hash = p_current_device_hash)
        order by d.status, d.last_seen_at desc nulls last)
      from public.auth_devices d
      left join public.staff ab on ab.id = d.approved_by
      left join public.staff ls on ls.id = d.last_staff_id), '[]'::jsonb));
end $function$
;
