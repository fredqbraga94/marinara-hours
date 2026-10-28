-- Rollback of 20261029010000_temp_reminder.sql: stops the reminders. The extensions stay.
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('mh-temp-opening', 'mh-temp-closing');
  end if;
end $do$;
drop function if exists public.mh_temp_reminder_tick(text);
drop function if exists public.mh_temp_reminder_due(text, text);
drop table if exists public.mh_cron_config;
drop table if exists public.temp_reminders;
