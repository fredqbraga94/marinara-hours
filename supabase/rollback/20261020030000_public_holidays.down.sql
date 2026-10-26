-- Rollback of 20261020030000_public_holidays.sql
-- Removes the public holiday list. Nothing else is touched.
drop table if exists public.public_holidays;
