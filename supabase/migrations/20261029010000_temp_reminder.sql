-- Temperature check reminders on the managers' phones: at 11:00 if opening
-- checks are missing, at 20:45 if closing checks are missing (Brisbane time,
-- no daylight saving: 01:00 and 10:45 UTC). A reminder is sent at most once per
-- location, day and check, and only when something is still missing. It goes to
-- the kitchen: the Administrator and the Kitchen Managers (not the Floor).
-- The database clock (pg_cron) calls the server with a private key kept in this
-- database; the server sends the notifications (Web Push, as for time off).
-- Additive only: two new tables, two new functions, two scheduled jobs.

create table if not exists public.temp_reminders (
  location text not null,
  day date not null,
  slot text not null check (slot in ('opening', 'closing')),
  missing integer not null,
  sent_at timestamptz not null default now(),
  primary key (location, day, slot)
);
alter table public.temp_reminders enable row level security;
revoke all on public.temp_reminders from anon, authenticated;

-- One row: the key the scheduled job sends, and the server address (set once
-- per project after this migration; without it the job does nothing).
create table if not exists public.mh_cron_config (
  id boolean primary key default true check (id),
  key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  url text check (url is null or url like 'https://%.supabase.co/functions/v1/%')
);
insert into public.mh_cron_config (id) values (true) on conflict (id) do nothing;
alter table public.mh_cron_config enable row level security;
revoke all on public.mh_cron_config from anon, authenticated;

-- Which locations need a reminder now. Wrong key: refused. Each location, day
-- and check is returned once (the second call the same day returns nothing).
create or replace function public.mh_temp_reminder_due(p_key text, p_slot text)
returns table (location text, missing integer, total integer, names text)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_day date := (now() at time zone 'Australia/Brisbane')::date;
begin
  if p_key is null or not exists (select 1 from public.mh_cron_config c where c.key = p_key) then
    raise exception 'NOT_ALLOWED';
  end if;
  if p_slot not in ('opening', 'closing') then raise exception 'INVALID_INPUT'; end if;
  return query
  with todo as (
    select e.location, count(*)::int as total,
           count(*) filter (where not exists (
             select 1 from public.temp_logs l
              where l.equipment_id = e.id and l.slot = p_slot
                and (l.recorded_at at time zone 'Australia/Brisbane')::date = v_day))::int as missing,
           string_agg(e.name, ', ' order by e.created_at) filter (where not exists (
             select 1 from public.temp_logs l
              where l.equipment_id = e.id and l.slot = p_slot
                and (l.recorded_at at time zone 'Australia/Brisbane')::date = v_day)) as names
      from public.temp_equipment e
     where e.active
     group by e.location
  ), fresh as (
    insert into public.temp_reminders (location, day, slot, missing)
    select t.location, v_day, p_slot, t.missing from todo t where t.missing > 0
    on conflict do nothing
    returning temp_reminders.location
  )
  select t.location, t.missing, t.total, t.names from todo t join fresh f on f.location = t.location;
end $function$;

-- Called by the scheduled jobs: asks the server to send the reminders.
create or replace function public.mh_temp_reminder_tick(p_slot text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  c public.mh_cron_config%rowtype;
begin
  select * into c from public.mh_cron_config where id;
  if c.url is null then return; end if;
  perform net.http_post(
    url := c.url,
    body := jsonb_build_object('action', 'cron_temp_reminder', 'key', c.key, 'slot', p_slot),
    headers := '{"Content-Type": "application/json"}'::jsonb);
end $function$;

revoke all on function public.mh_temp_reminder_due(text, text) from public, anon, authenticated;
revoke all on function public.mh_temp_reminder_tick(text) from public, anon, authenticated;
grant execute on function public.mh_temp_reminder_due(text, text) to service_role;

-- The clock: only where pg_cron and pg_net are available (Supabase); a plain
-- PostgreSQL test database simply has no schedule.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname in ('mh-temp-opening', 'mh-temp-closing');
    perform cron.schedule('mh-temp-opening', '0 1 * * *', $$select public.mh_temp_reminder_tick('opening')$$);
    perform cron.schedule('mh-temp-closing', '45 10 * * *', $$select public.mh_temp_reminder_tick('closing')$$);
  end if;
end $do$;
