-- Rollback of 20261112000000_supplier_departments.sql: one Suppliers list
-- again. Run only when no supplier name is in both lists.
drop function if exists public.manager_supplier_list(uuid, text);
drop index if exists public.suppliers_location_dept_name_idx;
create unique index if not exists suppliers_location_name_idx on public.suppliers (location, lower(name)) where active;

create or replace function public.mh_supplier_json(s public.suppliers)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object('id', s.id, 'name', s.name, 'contact', s.contact, 'phone', s.phone, 'email', s.email, 'note', s.note)
$function$;

-- Add a supplier, or edit one. p_supplier: {id?, name, contact?, phone?, email?, note?}.
create or replace function public.manager_supplier_save(p_manager_id uuid, p_supplier jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_name text := left(trim(coalesce(p_supplier->>'name', '')), 60);
  v_contact text := nullif(left(trim(coalesce(p_supplier->>'contact', '')), 80), '');
  v_phone text := nullif(left(trim(coalesce(p_supplier->>'phone', '')), 30), '');
  v_email text := nullif(lower(left(trim(coalesce(p_supplier->>'email', '')), 120)), '');
  v_note text := nullif(left(trim(coalesce(p_supplier->>'note', '')), 300), '');
  v_id uuid := case when p_supplier ? 'id' and p_supplier->>'id' is not null then (p_supplier->>'id')::uuid end;
  v_row public.suppliers%rowtype;
begin
  if v_name = '' then raise exception 'INVALID_INPUT'; end if;
  if exists (select 1 from public.suppliers s where s.location = mgr.location and s.active
               and lower(s.name) = lower(v_name) and s.id is distinct from v_id) then
    raise exception 'SUPPLIER_EXISTS';
  end if;
  if v_id is not null then
    update public.suppliers
       set name = v_name, contact = v_contact, phone = v_phone, email = v_email, note = v_note,
           updated_by = p_manager_id, updated_at = now()
     where id = v_id and location = mgr.location and active
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    insert into public.suppliers (location, name, contact, phone, email, note, created_by)
    values (mgr.location, v_name, v_contact, v_phone, v_email, v_note, p_manager_id)
    returning * into v_row;
  end if;
  return public.mh_supplier_json(v_row);
exception
  when check_violation or invalid_text_representation then raise exception 'INVALID_INPUT';
  when unique_violation then raise exception 'SUPPLIER_EXISTS';
end $function$;

-- Remove a supplier (kept in the table, hidden from the list).
create or replace function public.manager_supplier_remove(p_manager_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  update public.suppliers set active = false, updated_by = p_manager_id, updated_at = now()
   where id = p_id and location = mgr.location and active;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  return jsonb_build_object('removed', true);
end $function$;

alter table public.suppliers drop column if exists department;

revoke all on function public.manager_supplier_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_supplier_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.manager_supplier_save(uuid, jsonb) to service_role;
grant execute on function public.manager_supplier_remove(uuid, uuid) to service_role;
