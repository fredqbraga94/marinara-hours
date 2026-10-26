-- Roster order: the manager decides the order of people inside each role on
-- the roster (e.g. Khan, David, Fred... for Chef).
-- Additive only: one new staff column (empty = alphabetical, after the ones
-- that have a position) and one new audited function. Nothing existing changes.

alter table public.staff
  add column if not exists roster_order integer;

-- p_staff_ids: JSON array of staff ids, in the order wanted. Each gets 10, 20, 30...; people not
-- in the list keep theirs. Department-scoped managers can only order their
-- own department.
create or replace function public.manager_set_roster_order_audited(
  p_manager_id uuid,
  p_staff_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  v_n integer;
  v_bad integer;
begin
  if p_staff_ids is null or jsonb_typeof(p_staff_ids) <> 'array' then raise exception 'INVALID_INPUT'; end if;
  v_n := jsonb_array_length(p_staff_ids);
  if v_n = 0 or v_n > 200 then raise exception 'INVALID_INPUT'; end if;
  select count(*) into v_bad
    from jsonb_array_elements_text(p_staff_ids) x(id)
    left join public.staff s on s.id = x.id::uuid
   where s.id is null
      or (s.location is distinct from mgr.location and mgr.role <> 'admin')
      or (v_scope is not null and s.department is distinct from v_scope);
  if v_bad > 0 then raise exception 'DEPARTMENT_DENIED'; end if;

  update public.staff s
     set roster_order = x.n * 10
    from jsonb_array_elements_text(p_staff_ids) with ordinality as x(id, n)
   where s.id = x.id::uuid;

  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (null, mgr.id, mgr.id, 'manager_set_roster_order', null,
          jsonb_build_object('staff_ids', p_staff_ids));

  return jsonb_build_object('ordered', v_n);
exception
  when invalid_text_representation then raise exception 'INVALID_INPUT';
end $function$;

revoke all on function public.manager_set_roster_order_audited(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.manager_set_roster_order_audited(uuid, jsonb) to service_role;
