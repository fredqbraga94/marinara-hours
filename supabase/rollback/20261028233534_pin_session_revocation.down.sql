-- Roll back the Edge handler first. This restores the old session-retention risk.
-- No employee, shift or audit rows are removed.
drop function if exists public.staff_change_pin_secure(uuid,text,text,text);
