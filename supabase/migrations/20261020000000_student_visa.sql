-- Student visa (subclass 500) work-hours flag.
-- Additive only: two new columns with safe defaults and one new audited
-- function. No existing row, function, policy or grant is changed, so the
-- running app keeps working unchanged with this migration in place.
--
-- student_visa       : the person holds a student visa with the 48h/fortnight limit
-- visa_course_break  : the course is on an official break (no hour limit applies)

alter table public.staff
  add column if not exists student_visa boolean not null default false,
  add column if not exists visa_course_break boolean not null default false;

create or replace function public.manager_set_student_visa_audited(
  p_manager_id uuid,
  p_staff_id uuid,
  p_student_visa boolean,
  p_course_break boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  st public.staff%rowtype;
  v_old jsonb;
begin
  select * into st from public.staff where id = p_staff_id for no key update;
  if not found or (st.location is distinct from mgr.location and mgr.role <> 'admin') then
    raise exception 'STAFF_NOT_FOUND';
  end if;
  if v_scope is not null and st.department is distinct from v_scope then
    raise exception 'DEPARTMENT_DENIED';
  end if;

  v_old := public.mh_staff_json(p_staff_id)
    || jsonb_build_object('student_visa', st.student_visa, 'visa_course_break', st.visa_course_break);

  update public.staff
     set student_visa = coalesce(p_student_visa, false),
         -- a break only makes sense for someone on a student visa
         visa_course_break = coalesce(p_student_visa, false) and coalesce(p_course_break, false)
   where id = p_staff_id;

  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  select p_staff_id, p_staff_id, mgr.id, 'manager_set_student_visa', v_old,
         public.mh_staff_json(p_staff_id)
           || jsonb_build_object('student_visa', s.student_visa, 'visa_course_break', s.visa_course_break)
    from public.staff s where s.id = p_staff_id;

  return (select jsonb_build_object('id', s.id, 'student_visa', s.student_visa,
                                    'visa_course_break', s.visa_course_break)
            from public.staff s where s.id = p_staff_id);
end $function$;

revoke all on function public.manager_set_student_visa_audited(uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.manager_set_student_visa_audited(uuid, uuid, boolean, boolean) to service_role;
