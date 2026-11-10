-- Suppliers in two lists, Kitchen and Floor, like Notes and Stock: the Kitchen
-- Manager sees and edits only Kitchen suppliers, the Floor Manager only Floor
-- suppliers, the Administrator both. A supplier for both (e.g. food and wine)
-- can be in each list. Suppliers saved before this stay in Kitchen until a
-- manager moves them.
-- Changes: one column on public.suppliers, the name check per department, a
-- department on manager_supplier_save and manager_supplier_remove, and a new
-- manager_supplier_list(uuid, text). The old manager_supplier_list(uuid) is
-- kept unchanged for the server running before this change.

alter table public.suppliers add column if not exists department text not null default 'Kitchen'
  check (department in ('Kitchen', 'Floor'));
drop index if exists public.suppliers_location_name_idx;
create unique index if not exists suppliers_location_dept_name_idx on public.suppliers (location, department, lower(name)) where active;

create or replace function public.mh_supplier_json(s public.suppliers)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object('id', s.id, 'name', s.name, 'contact', s.contact, 'phone', s.phone, 'email', s.email, 'note', s.note, 'department', s.department)
$function$;

-- The suppliers of one department, and the names used in that department's
-- Stock and in the Orders and Invoices (Kitchen) not on its list yet.
create or replace function public.manager_supplier_list(p_manager_id uuid, p_department text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_dep text := public.mh_stock_department(mgr.role, p_department);
begin
  return jsonb_build_object(
    'location', mgr.location,
    'department', v_dep,
    'can_choose_department', public.mh_scope(mgr.role) is null,
    'suppliers', coalesce((
      select jsonb_agg(public.mh_supplier_json(s) order by lower(s.name))
        from public.suppliers s where s.location = mgr.location and s.department = v_dep and s.active), '[]'::jsonb),
    'known', coalesce((
      select jsonb_agg(n order by lower(n)) from (
        select distinct on (lower(trim(x.n))) trim(x.n) n from (
          select i.supplier n from public.stock_items i where i.location = mgr.location and i.department = v_dep and i.active
          union all select o.supplier from public.supplier_order_items o where v_dep = 'Kitchen' and o.location = mgr.location and o.active
          union all select v.supplier from public.supplier_invoices v where v_dep = 'Kitchen' and v.location = mgr.location and v.active
        ) x
        where length(trim(coalesce(x.n, ''))) between 1 and 60
          and not exists (select 1 from public.suppliers s where s.location = mgr.location and s.department = v_dep and s.active and lower(s.name) = lower(trim(x.n)))
        order by lower(trim(x.n)), trim(x.n)
      ) k), '[]'::jsonb));
end $function$;

-- Add a supplier, edit one, or move it to the other list (Administrator).
-- p_supplier: {id?, department?, name, contact?, phone?, email?, note?}.
-- Without a department: the manager's own (Kitchen for the Administrator).
create or replace function public.manager_supplier_save(p_manager_id uuid, p_supplier jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
  v_dep text := public.mh_stock_department(mgr.role, coalesce(nullif(p_supplier->>'department', ''), v_scope, 'Kitchen'));
  v_name text := left(trim(coalesce(p_supplier->>'name', '')), 60);
  v_contact text := nullif(left(trim(coalesce(p_supplier->>'contact', '')), 80), '');
  v_phone text := nullif(left(trim(coalesce(p_supplier->>'phone', '')), 30), '');
  v_email text := nullif(lower(left(trim(coalesce(p_supplier->>'email', '')), 120)), '');
  v_note text := nullif(left(trim(coalesce(p_supplier->>'note', '')), 300), '');
  v_id uuid := case when p_supplier ? 'id' and p_supplier->>'id' is not null then (p_supplier->>'id')::uuid end;
  v_row public.suppliers%rowtype;
begin
  if v_name = '' then raise exception 'INVALID_INPUT'; end if;
  if exists (select 1 from public.suppliers s where s.location = mgr.location and s.department = v_dep and s.active
               and lower(s.name) = lower(v_name) and s.id is distinct from v_id) then
    raise exception 'SUPPLIER_EXISTS';
  end if;
  if v_id is not null then
    update public.suppliers
       set name = v_name, contact = v_contact, phone = v_phone, email = v_email, note = v_note, department = v_dep,
           updated_by = p_manager_id, updated_at = now()
     where id = v_id and location = mgr.location and active and (v_scope is null or department = v_scope)
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    insert into public.suppliers (location, department, name, contact, phone, email, note, created_by)
    values (mgr.location, v_dep, v_name, v_contact, v_phone, v_email, v_note, p_manager_id)
    returning * into v_row;
  end if;
  return public.mh_supplier_json(v_row);
exception
  when check_violation or invalid_text_representation then raise exception 'INVALID_INPUT';
  when unique_violation then raise exception 'SUPPLIER_EXISTS';
end $function$;

-- Remove a supplier: only one of a list the manager can see.
create or replace function public.manager_supplier_remove(p_manager_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_scope text := public.mh_scope(mgr.role);
begin
  update public.suppliers set active = false, updated_by = p_manager_id, updated_at = now()
   where id = p_id and location = mgr.location and active and (v_scope is null or department = v_scope);
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  return jsonb_build_object('removed', true);
end $function$;

revoke all on function public.mh_supplier_json(public.suppliers) from public, anon, authenticated;
revoke all on function public.manager_supplier_list(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_supplier_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_supplier_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mh_supplier_json(public.suppliers) to service_role;
grant execute on function public.manager_supplier_list(uuid, text) to service_role;
grant execute on function public.manager_supplier_save(uuid, jsonb) to service_role;
grant execute on function public.manager_supplier_remove(uuid, uuid) to service_role;
