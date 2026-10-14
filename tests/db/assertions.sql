-- Assertions for the observe-only migration (pin_match_count) on an isolated DB.
\set ON_ERROR_STOP 1

-- Synthetic data only.
insert into public.staff (id, name, pin_hash, department, role, active) values
  ('00000000-0000-4000-8000-0000000000a1', 'Syn A', extensions.crypt('918273', extensions.gen_salt('bf')), 'Kitchen', 'staff', true),
  ('00000000-0000-4000-8000-0000000000a2', 'Syn B', extensions.crypt('918273', extensions.gen_salt('bf')), 'Floor', 'manager', true),
  ('00000000-0000-4000-8000-0000000000a3', 'Syn C', extensions.crypt('918273', extensions.gen_salt('bf')), 'Floor', 'staff', false),
  ('00000000-0000-4000-8000-0000000000a4', 'Syn D', extensions.crypt('4455', extensions.gen_salt('bf')), 'Kitchen', 'staff', true);
insert into public.staff (name, pin_hash, department)
  select 'Filler ' || g, extensions.crypt(lpad((100000 + g)::text, 6, '0'), extensions.gen_salt('bf')), 'Kitchen'
  from generate_series(1, 26) g;   -- 30 staff total, like a busy venue

create temp table before_state as
  select md5(string_agg(id::text || pin_hash || active::text, ',' order by id)) h, count(*) n from public.staff;

do $$
declare n integer; t0 timestamptz; ms numeric;
begin
  -- 1. Counts matches, never returns PINs or names.
  assert public.pin_match_count('918273') = 2, 'shared PIN among active accounts = 2';
  assert public.pin_match_count('4455') = 1, 'unique PIN = 1';
  assert public.pin_match_count('0000') = 0, 'unknown PIN = 0';
  assert public.pin_match_count('abc') = 0, 'malformed = 0';
  assert public.pin_match_count('') = 0, 'empty = 0';
  assert public.pin_match_count(null) = 0, 'null = 0';
  assert public.pin_match_count('918273 or 1=1') = 0, 'injection-shaped input = 0';

  -- 2. Existing login behaviour is unchanged.
  select count(*) into n from public.login_with_pin('918273'); assert n = 1, 'login_with_pin still returns 1 row';
  select count(*) into n from public.login_with_pin('9999');   assert n = 0, 'wrong PIN still returns 0 rows (no error)';

  -- 3. Cost on 30 staff (runs only after a successful login, in the background).
  t0 := clock_timestamp();
  perform public.pin_match_count('4455');
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  raise notice 'pin_match_count on 30 staff: % ms', round(ms, 1);
  assert ms < 2000, 'fast enough';

  -- 4. Declared read-only.
  assert (select provolatile from pg_proc where proname = 'pin_match_count') = 's', 'function is STABLE (read-only)';
end $$;

-- 5. Nothing was modified.
do $$ begin
  assert (select h from before_state) = (select md5(string_agg(id::text || pin_hash || active::text, ',' order by id)) from public.staff), 'staff rows unchanged';
end $$;

-- 6. Only the server (service_role) can call it.
set role anon;
do $$ begin
  begin perform public.pin_match_count('4455'); raise exception 'anon could call it';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
do $$ begin
  begin perform public.pin_match_count('4455'); raise exception 'authenticated could call it';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$ begin assert public.pin_match_count('4455') = 1, 'service_role can call it'; end $$;
reset role;

-- 7. Clock functions still work after the migration (regression).
do $$
declare st jsonb; a uuid := '00000000-0000-4000-8000-0000000000a4';
begin
  st := public.clock_in_by_id(a);    assert st->>'status' = 'working', 'clock in';
  st := public.start_break_by_id(a); assert st->>'status' = 'break', 'start break';
  st := public.end_break_by_id(a);   assert st->>'status' = 'working', 'end break';
  st := public.clock_out_by_id(a);   assert st->>'status' = 'off_shift', 'clock out';
  assert (select count(*) from public.breaks b join public.shifts s on s.id = b.shift_id where s.staff_id = a and b.break_end is not null) = 1, 'break recorded';
end $$;

-- 8. Rollback is clean: dropping the function leaves login and clock intact.
begin;
drop function public.pin_match_count(text);
do $$
declare n integer;
begin
  assert not exists (select 1 from pg_proc where proname = 'pin_match_count'), 'dropped';
  select count(*) into n from public.login_with_pin('4455'); assert n = 1, 'login works after rollback';
  assert (public.clock_in_by_id('00000000-0000-4000-8000-0000000000a1'))->>'status' = 'working', 'clock in works after rollback';
end $$;
rollback;

-- 9. Re-applying is idempotent.
\i supabase/migrations/20261012080000_pin_match_count.sql
do $$ begin assert public.pin_match_count('918273') = 2, 'idempotent re-apply'; end $$;

\echo 'pin_match_count assertions: OK'
