-- Structure-only snapshot of the production schema (project nnchgomdnnqsaovfivob),
-- taken read-only on 2026-10-12. NO production data.
-- Used to build an isolated local PostgreSQL for tests (tests/db/run.sh).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

grant usage on schema public, extensions to anon, authenticated, service_role;

create table public.staff (
  id uuid not null default gen_random_uuid() primary key,
  name text not null,
  pin_hash text not null,
  department text not null check (department = any (array['Kitchen'::text, 'Floor'::text])),
  location text not null default 'Hawthorne'::text,
  role text not null default 'staff'::text check (role = any (array['staff'::text, 'manager'::text, 'kitchen_manager'::text, 'floor_manager'::text])),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.shifts (
  id uuid not null default gen_random_uuid() primary key,
  staff_id uuid not null references public.staff(id),
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  status text not null default 'working'::text check (status = any (array['working'::text, 'break'::text, 'completed'::text])),
  approved boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create table public.breaks (
  id uuid not null default gen_random_uuid() primary key,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  break_start timestamptz not null default now(),
  break_end timestamptz,
  created_at timestamptz not null default now()
);

create table public.shift_audit (
  id uuid not null default gen_random_uuid() primary key,
  shift_id uuid references public.shifts(id) on delete cascade,
  changed_by uuid references public.staff(id),
  old_data jsonb,
  new_data jsonb,
  changed_at timestamptz not null default now()
);

create table public.pin_attempts (
  id uuid not null default gen_random_uuid() primary key,
  attempt_key text not null unique,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now()
);

create table public.staff_sessions (
  id uuid not null default gen_random_uuid() primary key,
  staff_id uuid not null references public.staff(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz not null default now()
);

create index breaks_shift_id_idx on public.breaks using btree (shift_id);
create index pin_attempts_locked_until_idx on public.pin_attempts using btree (locked_until);
create index shifts_clock_in_idx on public.shifts using btree (clock_in);
create unique index shifts_one_open_per_staff_uidx on public.shifts using btree (staff_id) where (clock_out is null);
create index shifts_staff_id_idx on public.shifts using btree (staff_id);
create index staff_sessions_expires_at_idx on public.staff_sessions using btree (expires_at);
create index staff_sessions_staff_id_idx on public.staff_sessions using btree (staff_id);
create index staff_sessions_token_hash_idx on public.staff_sessions using btree (token_hash);

alter table public.staff enable row level security;
alter table public.shifts enable row level security;
alter table public.breaks enable row level security;
alter table public.shift_audit enable row level security;
alter table public.pin_attempts enable row level security;
alter table public.staff_sessions enable row level security;

-- Production functions used by marinara-api-v2 (copied verbatim from pg_get_functiondef).

CREATE OR REPLACE FUNCTION public.login_with_pin(p_pin text)
 RETURNS TABLE(staff_id uuid, staff_name text, staff_role text, department text, location text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  select
    s.id,
    s.name,
    s.role,
    s.department,
    s.location
  from public.staff s
  where s.active = true
    and s.pin_hash = extensions.crypt(p_pin, s.pin_hash)
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.staff_status_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s public.staff%rowtype;
  sh public.shifts%rowtype;
  break_rows jsonb;
begin
  select * into s
  from public.staff
  where id = p_staff_id and active = true;

  if not found then
    raise exception 'STAFF_NOT_FOUND';
  end if;

  select * into sh
  from public.shifts
  where staff_id = p_staff_id
    and status in ('working','break')
  order by clock_in desc
  limit 1;

  if sh.id is not null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'break_start', b.break_start,
          'break_end', b.break_end
        )
        order by b.break_start
      ),
      '[]'::jsonb
    )
    into break_rows
    from public.breaks b
    where b.shift_id = sh.id;
  else
    break_rows := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'staff_id', s.id,
    'staff_name', s.name,
    'staff_role', s.role,
    'department', s.department,
    'location', s.location,
    'status', case
      when sh.id is null then 'off_shift'
      else sh.status
    end,
    'shift_id', sh.id,
    'clock_in', sh.clock_in,
    'breaks', break_rows
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.clock_in_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sh public.shifts%rowtype;
begin
  if not exists(select 1 from public.staff where id=p_staff_id and active=true) then raise exception 'STAFF_NOT_FOUND'; end if;
  if exists(select 1 from public.shifts where staff_id=p_staff_id and status in ('working','break')) then raise exception 'SHIFT_ALREADY_OPEN'; end if;
  insert into public.shifts(staff_id, clock_in, status) values(p_staff_id, now(), 'working') returning * into sh;
  return public.staff_status_by_id(p_staff_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.start_break_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sh public.shifts%rowtype;
begin
  select * into sh from public.shifts where staff_id=p_staff_id and status='working' order by clock_in desc limit 1;
  if not found then raise exception 'NO_WORKING_SHIFT'; end if;
  insert into public.breaks(shift_id, break_start) values(sh.id, now());
  update public.shifts set status='break' where id=sh.id;
  return public.staff_status_by_id(p_staff_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.end_break_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sh public.shifts%rowtype; br public.breaks%rowtype;
begin
  select * into sh from public.shifts where staff_id=p_staff_id and status='break' order by clock_in desc limit 1;
  if not found then raise exception 'NO_ACTIVE_BREAK'; end if;
  select * into br from public.breaks where shift_id=sh.id and break_end is null order by break_start desc limit 1;
  if not found then raise exception 'NO_ACTIVE_BREAK'; end if;
  update public.breaks set break_end=now() where id=br.id;
  update public.shifts set status='working' where id=sh.id;
  return public.staff_status_by_id(p_staff_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.clock_out_by_id(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  sh public.shifts%rowtype;
begin
  select *
  into sh
  from public.shifts
  where staff_id = p_staff_id
    and status in ('working','break')
  order by clock_in desc
  limit 1;

  if not found then
    raise exception 'NO_OPEN_SHIFT';
  end if;

  if sh.status = 'break' then
    raise exception 'END_BREAK_REQUIRED';
  end if;

  update public.shifts
  set
    clock_out = now(),
    status = 'completed'
  where id = sh.id;

  return public.staff_status_by_id(p_staff_id);
end;
$function$;

revoke all on function public.login_with_pin(text) from public, anon, authenticated;
revoke all on function public.staff_status_by_id(uuid) from public, anon, authenticated;
revoke all on function public.clock_in_by_id(uuid) from public, anon, authenticated;
revoke all on function public.start_break_by_id(uuid) from public, anon, authenticated;
revoke all on function public.end_break_by_id(uuid) from public, anon, authenticated;
revoke all on function public.clock_out_by_id(uuid) from public, anon, authenticated;
grant execute on function public.login_with_pin(text) to service_role;
grant execute on function public.staff_status_by_id(uuid) to service_role;
grant execute on function public.clock_in_by_id(uuid) to service_role;
grant execute on function public.start_break_by_id(uuid) to service_role;
grant execute on function public.end_break_by_id(uuid) to service_role;
grant execute on function public.clock_out_by_id(uuid) to service_role;
