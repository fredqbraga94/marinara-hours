-- Rollback of 20261020000000_student_visa.sql
-- Removes the student visa flag and its function. No shift, break or audit
-- row is touched (audit rows written by the function are kept as history).
drop function if exists public.manager_set_student_visa_audited(uuid, uuid, boolean, boolean);
alter table public.staff drop column if exists visa_course_break;
alter table public.staff drop column if exists student_visa;
