-- Marinara Hours — authorised devices, PIN attempt limits and shared PINs
-- (replaces draft PR #3). Used by Edge Function v38. Adds new objects only;
-- v37 keeps working unchanged on a database with this migration.
--
-- Why devices: a PIN request carries nothing the server can trust except what
-- the server itself issued. IP headers can be forged or shared by the whole
-- restaurant Wi-Fi, and a per-request "device id" can be invented at will.
-- So attempts are limited per *authorised* device (a secret only that device
-- holds, approved once), and every unknown device shares one small allowance.
--   - An attacker can only burn the shared allowance: authorised devices keep
--     working (no collective lockout of the staff).
--   - In 'enforce' mode unknown devices cannot try PINs at all; new devices are
--     added with a one-time pairing code issued by a manager (or by the owner
--     from the Supabase SQL editor for recovery).
--   - In 'grace' mode (the starting mode) a device becomes authorised the first
--     time someone logs in on it, or as soon as it shows a session that was
--     already open. This lets current phones migrate without interruption.
--
-- Rollback: supabase/rollback/20261013020000_device_auth_pin_limits.down.sql

-- ---------------------------------------------------------------- settings
create table if not exists public.auth_settings (
  id boolean primary key default true check (id),
  device_mode text not null default 'grace' check (device_mode in ('grace', 'enforce')),
  -- unknown devices (shared allowance)
  unknown_short_limit integer not null default 5 check (unknown_short_limit > 0),
  unknown_daily_limit integer not null default 15 check (unknown_daily_limit > 0),
  -- each authorised device
  device_short_limit integer not null default 5 check (device_short_limit > 0),
  device_daily_limit integer not null default 20 check (device_daily_limit > 0),
  -- pairing code attempts (shared)
  pairing_short_limit integer not null default 10 check (pairing_short_limit > 0),
  short_window_minutes integer not null default 15 check (short_window_minutes > 0),
  pairing_code_minutes integer not null default 15 check (pairing_code_minutes between 1 and 1440),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff(id) on delete set null
);
insert into public.auth_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------- devices
-- Only authorised (or revoked) devices are stored; unknown devices create no rows.
create table if not exists public.auth_devices (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null unique check (device_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('approved', 'revoked')),
  label text check (label is null or length(label) <= 60),
  approved_via text not null check (approved_via in ('pin_grace', 'session', 'pairing')),
  approved_by uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.staff(id) on delete set null,
  last_seen_at timestamptz,
  last_staff_id uuid references public.staff(id) on delete set null
);

create table if not exists public.auth_attempt_buckets (
  bucket text primary key,              -- 'unknown', 'pairing' or 'device:<uuid>'
  short_failures integer not null default 0,
  short_window_start timestamptz,
  daily_failures integer not null default 0,
  daily_window_start timestamptz,
  locked_until timestamptz,
  last_failure_at timestamptz
);

create table if not exists public.auth_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.staff(id) on delete set null,   -- null = owner recovery code
  label text check (label is null or length(label) <= 60),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_device_id uuid references public.auth_devices(id)
);

-- Security events (no PINs, tokens or IP addresses).
create table if not exists public.auth_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  event text not null,
  device_id uuid references public.auth_devices(id),
  staff_id uuid references public.staff(id) on delete set null,
  manager_id uuid references public.staff(id) on delete set null,
  detail jsonb
);
create index if not exists auth_events_at_idx on public.auth_events (at);

-- Sessions remember the device they were created on. Existing sessions keep
-- device_id = null and stay valid until they expire as before.
alter table public.staff_sessions add column if not exists device_id uuid references public.auth_devices(id);
create index if not exists staff_sessions_device_id_idx on public.staff_sessions (device_id);

alter table public.auth_settings enable row level security;
alter table public.auth_devices enable row level security;
alter table public.auth_attempt_buckets enable row level security;
alter table public.auth_pairing_codes enable row level security;
alter table public.auth_events enable row level security;

-- ---------------------------------------------------------------- attempt buckets
-- Locks the bucket row without waiting: a flood of requests on one bucket can
-- never hold database connections (the extra requests get 'busy').
create or replace function public.auth_bucket_lock(p_bucket text)
returns public.auth_attempt_buckets
language plpgsql security definer set search_path to 'public'
as $$
declare b public.auth_attempt_buckets%rowtype;
begin
  insert into public.auth_attempt_buckets (bucket) values (p_bucket) on conflict (bucket) do nothing;
  select * into b from public.auth_attempt_buckets where bucket = p_bucket for update nowait;
  return b;
end $$;

create or replace function public.auth_bucket_fail(p_bucket text, p_short_limit integer, p_daily_limit integer, p_minutes integer)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  b public.auth_attempt_buckets%rowtype;
  v_now timestamptz := now();
  v_remaining integer;
begin
  select * into b from public.auth_attempt_buckets where bucket = p_bucket;  -- already locked by caller
  if b.short_window_start is null or b.short_window_start <= v_now - make_interval(mins => p_minutes) then
    b.short_failures := 0; b.short_window_start := v_now;
  end if;
  if b.daily_window_start is null or b.daily_window_start <= v_now - interval '24 hours' then
    b.daily_failures := 0; b.daily_window_start := v_now;
  end if;
  b.short_failures := b.short_failures + 1;
  b.daily_failures := b.daily_failures + 1;
  b.locked_until := null;
  if b.daily_failures >= p_daily_limit then
    b.locked_until := b.daily_window_start + interval '24 hours';
  elsif b.short_failures >= p_short_limit then
    b.locked_until := v_now + make_interval(mins => p_minutes);
  end if;
  update public.auth_attempt_buckets
     set short_failures = b.short_failures, short_window_start = b.short_window_start,
         daily_failures = b.daily_failures, daily_window_start = b.daily_window_start,
         locked_until = b.locked_until, last_failure_at = v_now
   where bucket = p_bucket;
  if b.locked_until is not null then
    insert into public.auth_events (event, detail)
    values ('bucket_locked', jsonb_build_object('bucket', case when p_bucket like 'device:%' then 'device' else p_bucket end,
                                                'device_id', case when p_bucket like 'device:%' then substr(p_bucket, 8) end,
                                                'until', b.locked_until));
  end if;
  v_remaining := greatest(0, least(p_short_limit - b.short_failures, p_daily_limit - b.daily_failures));
  return jsonb_build_object(
    'attempts_remaining', v_remaining,
    'retry_after_seconds', case when b.locked_until is null then 0
                                else greatest(1, ceil(extract(epoch from (b.locked_until - v_now)))::integer) end);
end $$;

-- ---------------------------------------------------------------- login
-- One transaction: device check, attempt limit, PIN check (all matches, never
-- "first match"), device authorisation in grace mode, session creation.
create or replace function public.auth_pin_login(
  p_pin text, p_device_hash text, p_token_hash text, p_expires_at timestamptz)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare
  cfg public.auth_settings%rowtype;
  dev public.auth_devices%rowtype;
  b public.auth_attempt_buckets%rowtype;
  v_bucket text;
  v_short integer; v_daily integer;
  v_matches uuid[];
  v_n integer := 0;
  st public.staff%rowtype;
  v_fail jsonb;
  v_new_device boolean := false;
  v_session_id uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_expires_at is null then
    raise exception 'INVALID_INPUT';
  end if;
  if p_device_hash is not null and p_device_hash !~ '^[0-9a-f]{64}$' then
    p_device_hash := null;
  end if;

  select * into cfg from public.auth_settings where id;
  if p_device_hash is not null then
    select * into dev from public.auth_devices where device_hash = p_device_hash;
  end if;

  if dev.status = 'revoked' then
    return jsonb_build_object('result', 'device_revoked');
  end if;

  if dev.status = 'approved' then
    v_bucket := 'device:' || dev.id; v_short := cfg.device_short_limit; v_daily := cfg.device_daily_limit;
  elsif cfg.device_mode = 'enforce' then
    return jsonb_build_object('result', 'device_not_authorized');
  else
    v_bucket := 'unknown'; v_short := cfg.unknown_short_limit; v_daily := cfg.unknown_daily_limit;
  end if;

  begin
    b := public.auth_bucket_lock(v_bucket);
  exception when lock_not_available then
    return jsonb_build_object('result', 'busy', 'retry_after_seconds', 2);
  end;

  if b.locked_until is not null and b.locked_until > now() then
    return jsonb_build_object('result', 'locked',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (b.locked_until - now())))::integer),
      'device', case when dev.id is null then 'unknown' else 'approved' end);
  end if;

  if p_pin ~ '^[0-9]{4,6}$' then
    select array_agg(s.id order by s.id) into v_matches
    from public.staff s
    where s.active = true and s.pin_hash = extensions.crypt(p_pin, s.pin_hash);
    v_n := coalesce(array_length(v_matches, 1), 0);
  end if;

  if v_n <> 1 then
    v_fail := public.auth_bucket_fail(v_bucket, v_short, v_daily, cfg.short_window_minutes);
    if v_n > 1 then
      -- The same PIN belongs to several people: never guess which one.
      update public.staff set pin_conflict_at = coalesce(pin_conflict_at, now()) where id = any (v_matches);
      insert into public.auth_events (event, device_id, detail)
      values ('pin_conflict', dev.id, jsonb_build_object('staff_count', v_n));
      return jsonb_build_object('result', 'pin_conflict') || v_fail;
    end if;
    return jsonb_build_object('result', 'invalid_pin',
                              'device', case when dev.id is null then 'unknown' else 'approved' end) || v_fail;
  end if;

  select * into st from public.staff where id = v_matches[1];

  if dev.id is null then
    -- grace mode: authorise this device on its first successful login
    if p_device_hash is not null then
      insert into public.auth_devices (device_hash, status, approved_via, approved_by, last_seen_at, last_staff_id)
      values (p_device_hash, 'approved', 'pin_grace', st.id, now(), st.id)
      on conflict (device_hash) do nothing
      returning * into dev;
      if dev.id is null then
        select * into dev from public.auth_devices where device_hash = p_device_hash;
        if dev.status <> 'approved' then return jsonb_build_object('result', 'device_revoked'); end if;
      else
        v_new_device := true;
        insert into public.auth_events (event, device_id, staff_id, detail)
        values ('device_approved', dev.id, st.id, jsonb_build_object('via', 'pin_grace'));
      end if;
    end if;
  else
    -- a correct PIN on an authorised device clears that device's counters
    update public.auth_attempt_buckets
       set short_failures = 0, short_window_start = null, daily_failures = 0, daily_window_start = null, locked_until = null
     where bucket = v_bucket;
  end if;

  if dev.id is not null then
    update public.auth_devices set last_seen_at = now(), last_staff_id = st.id where id = dev.id;
  end if;

  insert into public.staff_sessions (staff_id, token_hash, expires_at, last_used_at, device_id)
  values (st.id, p_token_hash, p_expires_at, now(), dev.id)
  returning id into v_session_id;

  return jsonb_build_object(
    'result', 'ok',
    'staff', jsonb_build_object('staff_id', st.id, 'staff_name', st.name, 'staff_role', st.role,
                                'department', st.department, 'location', st.location),
    'device', case when dev.id is null then null
                   else jsonb_build_object('status', 'approved', 'newly_approved', v_new_device) end);
end $$;

-- ---------------------------------------------------------------- session check
-- Replaces the three queries of validateStaffSession. Sessions created on a
-- device only work on that device. Sessions without a device (created before
-- v38, or by an old cached copy of the app) keep working; when such a session
-- is presented together with a device secret, that device is authorised
-- (it already proved a PIN) and the session becomes bound to it.
create or replace function public.auth_session(p_token_hash text, p_device_hash text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  s public.staff_sessions%rowtype;
  st public.staff%rowtype;
  dev public.auth_devices%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'Invalid or expired session');
  end if;
  if p_device_hash is not null and p_device_hash !~ '^[0-9a-f]{64}$' then
    p_device_hash := null;
  end if;

  select * into s from public.staff_sessions
   where token_hash = p_token_hash and revoked_at is null and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Invalid or expired session');
  end if;

  select * into st from public.staff where id = s.staff_id and active = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Staff account is inactive or unavailable');
  end if;

  if s.device_id is not null then
    select * into dev from public.auth_devices where id = s.device_id;
    if dev.status is distinct from 'approved' or p_device_hash is null or dev.device_hash <> p_device_hash then
      return jsonb_build_object('ok', false, 'error', 'Invalid or expired session');
    end if;
  elsif p_device_hash is not null then
    select * into dev from public.auth_devices where device_hash = p_device_hash;
    if dev.status = 'revoked' then
      return jsonb_build_object('ok', false, 'error', 'Invalid or expired session');
    end if;
    if dev.id is null then
      insert into public.auth_devices (device_hash, status, approved_via, approved_by, last_seen_at, last_staff_id)
      values (p_device_hash, 'approved', 'session', st.id, now(), st.id)
      on conflict (device_hash) do nothing
      returning * into dev;
      if dev.id is null then
        select * into dev from public.auth_devices where device_hash = p_device_hash;
        if dev.status <> 'approved' then
          return jsonb_build_object('ok', false, 'error', 'Invalid or expired session');
        end if;
      else
        insert into public.auth_events (event, device_id, staff_id, detail)
        values ('device_approved', dev.id, st.id, jsonb_build_object('via', 'session'));
      end if;
    end if;
    update public.staff_sessions set device_id = dev.id where id = s.id and device_id is null;
  end if;

  update public.staff_sessions set last_used_at = now() where id = s.id;
  if dev.id is not null then
    update public.auth_devices set last_seen_at = now(), last_staff_id = st.id where id = dev.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'expires_at', s.expires_at,
    'staff', jsonb_build_object('id', st.id, 'name', st.name, 'department', st.department,
                                'location', st.location, 'role', st.role, 'active', st.active));
end $$;

-- ---------------------------------------------------------------- pairing codes
create or replace function public.auth_create_pairing_code(p_manager_id uuid, p_code_hash text, p_label text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  cfg public.auth_settings%rowtype;
  v_expires timestamptz;
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
  select * into cfg from public.auth_settings where id;
  if (select count(*) from public.auth_pairing_codes
       where created_by = mgr.id and used_at is null and expires_at > now()) >= 5 then
    raise exception 'TOO_MANY_ACTIVE_CODES';
  end if;
  v_expires := now() + make_interval(mins => cfg.pairing_code_minutes);
  insert into public.auth_pairing_codes (code_hash, created_by, label, expires_at)
  values (p_code_hash, mgr.id, nullif(left(btrim(coalesce(p_label, '')), 60), ''), v_expires);
  insert into public.auth_events (event, manager_id, detail)
  values ('pairing_code_created', mgr.id, jsonb_build_object('expires_at', v_expires));
  return jsonb_build_object('expires_at', v_expires);
end $$;

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

-- Owner recovery (for example, no manager has an authorised device): run in the
-- Supabase SQL editor:  select public.auth_owner_pairing_code();
-- Returns a one-time code valid for the configured minutes. Not callable by the API.
create or replace function public.auth_owner_pairing_code(p_label text default 'Owner recovery')
returns text
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_code text := '';
  cfg public.auth_settings%rowtype;
begin
  select * into cfg from public.auth_settings where id;
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
  end loop;
  insert into public.auth_pairing_codes (code_hash, created_by, label, expires_at)
  values (encode(extensions.digest(v_code, 'sha256'), 'hex'), null, left(p_label, 60),
          now() + make_interval(mins => cfg.pairing_code_minutes));
  insert into public.auth_events (event, detail) values ('owner_pairing_code_created', null);
  return substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);
end $$;

-- ---------------------------------------------------------------- manager tools
create or replace function public.auth_list_devices(p_manager_id uuid, p_current_device_hash text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  cfg public.auth_settings%rowtype;
begin
  select * into cfg from public.auth_settings where id;
  return jsonb_build_object(
    'mode', cfg.device_mode,
    'can_change_mode', mgr.role = 'manager',
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
end $$;

create or replace function public.auth_revoke_device(p_manager_id uuid, p_device_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_sessions integer;
begin
  update public.auth_devices set status = 'revoked', revoked_at = now(), revoked_by = mgr.id
   where id = p_device_id and status = 'approved';
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
  if not exists (select 1 from public.auth_devices where id = p_device_id and status = 'approved') then
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
  update public.auth_devices set label = nullif(left(btrim(coalesce(p_label, '')), 60), '') where id = p_device_id;
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
  if mgr.role <> 'manager' then raise exception 'GM_REQUIRED'; end if;
  if p_mode not in ('grace', 'enforce') then raise exception 'INVALID_INPUT'; end if;
  select device_mode into v_old from public.auth_settings where id for update;
  update public.auth_settings set device_mode = p_mode, updated_at = now(), updated_by = mgr.id where id;
  insert into public.auth_events (event, manager_id, detail)
  values ('mode_changed', mgr.id, jsonb_build_object('from', v_old, 'to', p_mode));
  return jsonb_build_object('mode', p_mode);
end $$;

-- What the login screen needs to know before asking for a PIN.
create or replace function public.auth_device_status(p_device_hash text)
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select jsonb_build_object(
    'mode', (select device_mode from public.auth_settings where id),
    'device', coalesce((select status from public.auth_devices
                         where p_device_hash ~ '^[0-9a-f]{64}$' and device_hash = p_device_hash), 'unknown'))
$$;

-- ---------------------------------------------------------------- privileges
do $grants$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'auth\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname in ('auth_pin_login', 'auth_session', 'auth_device_status', 'auth_create_pairing_code', 'auth_redeem_pairing_code',
                     'auth_list_devices', 'auth_revoke_device', 'auth_unlock_device', 'auth_rename_device', 'auth_set_mode') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end
$grants$;

revoke all on public.auth_settings, public.auth_devices, public.auth_attempt_buckets,
              public.auth_pairing_codes, public.auth_events
  from anon, authenticated, service_role;
