-- Rollback of 20261021030000_floor_services.sql
-- Removes the Floor/Bar service times (Floor L/D cells then count 0 planned hours).
delete from public.roster_position_services where position in ('Floor', 'Bar');
delete from public.roster_services where department = 'Floor';
