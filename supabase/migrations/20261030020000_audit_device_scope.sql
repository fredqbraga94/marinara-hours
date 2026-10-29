-- Management ownership is separate from PIN/session authentication.
-- Devices with conflicting historical units remain unassigned for owner review.
-- This does not revoke sessions, alter PINs or change the device login mode.
alter table public.auth_devices add column if not exists management_location text;

with associations as (
  select d.id, s.location from public.auth_devices d join public.staff s on s.id = d.approved_by
  union
  select d.id, s.location from public.auth_devices d join public.staff s on s.id = d.last_staff_id
  union
  select d.id, s.location from public.auth_devices d join public.staff_sessions ss on ss.device_id = d.id
    join public.staff s on s.id = ss.staff_id
), unambiguous as (
  select id, min(location) location from associations group by id having count(distinct location) = 1
)
update public.auth_devices d set management_location = a.location
from unambiguous a where d.id = a.id and d.management_location is null;

-- New devices inherit the pairing authorizer's unit, or their first user for
-- owner recovery/grace devices. Ownership never changes silently on later login.
create or replace function public.mh_device_management_location()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.management_location is null and (tg_op = 'INSERT' or (old.approved_by is null and old.last_staff_id is null)) then
    select s.location into new.management_location from public.staff s
     where s.id = coalesce(new.approved_by, new.last_staff_id);
  end if;
  return new;
end $function$;
revoke all on function public.mh_device_management_location() from public, anon, authenticated, service_role;
drop trigger if exists mh_device_management_location on public.auth_devices;
create trigger mh_device_management_location before insert or update of approved_by, last_staff_id
 on public.auth_devices for each row execute function public.mh_device_management_location();

create or replace function public.auth_list_devices(p_manager_id uuid, p_current_device_hash text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  cfg public.auth_settings%rowtype;
begin
  -- Device administration stays in the home unit even while viewing another unit.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  select * into cfg from public.auth_settings where id;
  return jsonb_build_object(
    'mode', cfg.device_mode,
    'can_change_mode', mgr.role = 'manager' and not exists (select 1 from public.staff s where s.active and s.location is distinct from mgr.location),
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
      left join public.staff ab on ab.id = d.approved_by and ab.location = mgr.location
      left join public.staff ls on ls.id = d.last_staff_id and ls.location = mgr.location
      where d.management_location = mgr.location), '[]'::jsonb));
end $$;

create or replace function public.auth_revoke_device(p_manager_id uuid, p_device_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_sessions integer;
begin
  -- Device administration stays in the home unit even while viewing another unit.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  update public.auth_devices set status = 'revoked', revoked_at = now(), revoked_by = mgr.id
   where id = p_device_id and management_location = mgr.location and status = 'approved';
  if not found then raise exception 'DEVICE_NOT_FOUND'; end if;
  update public.staff_sessions set revoked_at = now() where device_id = p_device_id and revoked_at is null;
  get diagnostics v_sessions = row_count;
  insert into public.auth_events (event, device_id, manager_id, detail)
  values ('device_revoked', p_device_id, mgr.id, jsonb_build_object('sessions_ended', v_sessions));
  return jsonb_build_object('revoked', true, 'sessions_ended', v_sessions);
end $$;

create or replace function public.auth_unlock_device(p_manager_id uuid, p_device_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  -- Device administration stays in the home unit even while viewing another unit.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  if not exists (select 1 from public.auth_devices where id = p_device_id and management_location = mgr.location and status = 'approved') then
    raise exception 'DEVICE_NOT_FOUND';
  end if;
  update public.auth_attempt_buckets
     set short_failures = 0, short_window_start = null, daily_failures = 0, daily_window_start = null, locked_until = null
   where bucket = 'device:' || p_device_id;
  insert into public.auth_events (event, device_id, manager_id) values ('device_unlocked', p_device_id, mgr.id);
  return jsonb_build_object('unlocked', true);
end $$;

create or replace function public.auth_rename_device(p_manager_id uuid, p_device_id uuid, p_label text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  -- Device administration stays in the home unit even while viewing another unit.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  update public.auth_devices set label = nullif(left(btrim(coalesce(p_label, '')), 60), '') where id = p_device_id and management_location = mgr.location;
  if not found then raise exception 'DEVICE_NOT_FOUND'; end if;
  return jsonb_build_object('renamed', true);
end $$;

create or replace function public.auth_set_mode(p_manager_id uuid, p_mode text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_old text;
begin
  -- Device administration stays in the home unit even while viewing another unit.
  select st.location into mgr.location from public.staff st where st.id = mgr.id;
  if mgr.role <> 'manager' then raise exception 'GM_REQUIRED'; end if;
  if exists (select 1 from public.staff s where s.active and s.location is distinct from mgr.location) then
    raise exception 'GLOBAL_OWNER_REQUIRED';
  end if;
  if p_mode not in ('grace', 'enforce') then raise exception 'INVALID_INPUT'; end if;
  select device_mode into v_old from public.auth_settings where id for update;
  update public.auth_settings set device_mode = p_mode, updated_at = now(), updated_by = mgr.id where id;
  insert into public.auth_events (event, manager_id, detail)
  values ('mode_changed', mgr.id, jsonb_build_object('from', v_old, 'to', p_mode));
  return jsonb_build_object('mode', p_mode);
end $$;
revoke all on function public.auth_list_devices(uuid,text) from public, anon, authenticated;
grant execute on function public.auth_list_devices(uuid,text) to service_role;
revoke all on function public.auth_revoke_device(uuid,uuid) from public, anon, authenticated;
grant execute on function public.auth_revoke_device(uuid,uuid) to service_role;
revoke all on function public.auth_unlock_device(uuid,uuid) from public, anon, authenticated;
grant execute on function public.auth_unlock_device(uuid,uuid) to service_role;
revoke all on function public.auth_rename_device(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.auth_rename_device(uuid,uuid,text) to service_role;
revoke all on function public.auth_set_mode(uuid,text) from public, anon, authenticated;
grant execute on function public.auth_set_mode(uuid,text) to service_role;

create or replace function public.auth_redeem_pairing_code(p_code_hash text, p_device_hash text, p_label text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  cfg public.auth_settings%rowtype;
  b public.auth_attempt_buckets%rowtype;
  c public.auth_pairing_codes%rowtype;
  dev public.auth_devices%rowtype;
  v_fail jsonb;
  v_issuer_location text;
begin
  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
  select * into cfg from public.auth_settings where id;
  begin
    b := public.auth_bucket_lock('pairing');
  exception when lock_not_available then
    return jsonb_build_object('result', 'busy', 'retry_after_seconds', 2);
  end;
  if b.locked_until is not null and b.locked_until > now() then
    return jsonb_build_object('result', 'locked',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (b.locked_until - now())))::integer));
  end if;

  if p_code_hash ~ '^[0-9a-f]{64}$' then
    select * into c from public.auth_pairing_codes
     where code_hash = p_code_hash and used_at is null and expires_at > now()
     for update;
  end if;
  if c.id is null then
    v_fail := public.auth_bucket_fail('pairing', cfg.pairing_short_limit, cfg.pairing_short_limit * 4, cfg.short_window_minutes);
    return jsonb_build_object('result', 'invalid_code') || v_fail;
  end if;

  select * into dev from public.auth_devices where device_hash = p_device_hash for update;
  -- A venue-issued code cannot administer a foreign or unassigned device.
  -- Owner recovery codes (created_by IS NULL) remain the explicit global path.
  if c.created_by is not null then
    select s.location into v_issuer_location from public.staff s
      where s.id = c.created_by and s.active
        and s.role in ('manager', 'kitchen_manager', 'floor_manager');
    if v_issuer_location is null or (dev.id is not null and dev.management_location is distinct from v_issuer_location) then
      return jsonb_build_object('result', 'invalid_code');
    end if;
  end if;
  if dev.id is null then
    insert into public.auth_devices (device_hash, status, label, approved_via, approved_by, last_seen_at)
    values (p_device_hash, 'approved', coalesce(nullif(left(btrim(coalesce(p_label, '')), 60), ''), c.label),
            'pairing', c.created_by, now())
    returning * into dev;
  else
    update public.auth_devices
       set status = 'approved', approved_via = 'pairing', approved_by = c.created_by, approved_at = now(),
           revoked_at = null, revoked_by = null, last_seen_at = now(),
           label = coalesce(nullif(left(btrim(coalesce(p_label, '')), 60), ''), c.label, label)
     where id = dev.id
    returning * into dev;
  end if;
  update public.auth_pairing_codes set used_at = now(), used_device_id = dev.id where id = c.id;
  update public.auth_attempt_buckets
     set short_failures = 0, short_window_start = null, daily_failures = 0, daily_window_start = null, locked_until = null
   where bucket = 'device:' || dev.id;
  insert into public.auth_events (event, device_id, manager_id, detail)
  values ('device_approved', dev.id, c.created_by, jsonb_build_object('via', case when c.created_by is null then 'owner_code' else 'pairing' end));
  return jsonb_build_object('result', 'ok', 'device_id', dev.id);
end $$;
revoke all on function public.auth_redeem_pairing_code(text,text,text) from public, anon, authenticated;
grant execute on function public.auth_redeem_pairing_code(text,text,text) to service_role;
