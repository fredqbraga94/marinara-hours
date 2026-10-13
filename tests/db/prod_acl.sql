-- Table privileges exactly as in production (read-only catalog check, 2026-10-13).
-- Production is PostgreSQL 17 and also grants MAINTAIN ("m"); PostgreSQL 16 has
-- no MAINTAIN privilege, everything else is identical.
--   breaks          authenticated=Dxt(m)   service_role=arwdDxt(m)
--   pin_attempts                          service_role=arwdDxt(m)
--   shift_audit     authenticated=Dxt(m)   service_role=Dxt(m)
--   shifts          authenticated=Dxt(m)   service_role=arwdDxt(m)
--   staff           authenticated=Dxt(m)   service_role=rwDxt(m)     (no INSERT)
--   staff_sessions                        service_role=arwdDxt(m)
-- Default privileges for tables created by postgres: anon/authenticated/service_role = Dxt(m).

revoke all on all tables in schema public from anon, authenticated, service_role;

grant truncate, references, trigger on public.breaks, public.shift_audit, public.shifts, public.staff to authenticated;
grant select, insert, update, delete, truncate, references, trigger on public.breaks, public.pin_attempts, public.shifts, public.staff_sessions to service_role;
grant truncate, references, trigger on public.shift_audit to service_role;
grant select, update, truncate, references, trigger on public.staff to service_role;

alter default privileges for role postgres in schema public grant truncate, references, trigger on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public;

alter role service_role bypassrls;
