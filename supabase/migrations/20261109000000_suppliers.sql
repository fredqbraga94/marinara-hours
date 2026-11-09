-- Suppliers: who we buy from, with the contact person, phone and email, so a
-- manager can call or email them straight from the app (Stock & Orders →
-- Suppliers). Any manager can add, edit or remove one. One list per location.
-- The names already used in Stock, Orders and Invoices are offered as
-- suggestions, so the same supplier is written the same way.
-- Additive only: one new table and four new functions. Nothing existing changes.

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  name text not null check (length(trim(name)) between 1 and 60),
  contact text check (contact is null or length(contact) <= 80),
  phone text check (phone is null or (length(trim(phone)) between 3 and 30 and phone ~ '^[0-9+() .-]+$')),
  email text check (email is null or (length(email) <= 120 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  note text check (note is null or length(note) <= 300),
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  updated_by uuid references public.staff(id),
  updated_at timestamptz
);
create unique index if not exists suppliers_location_name_idx on public.suppliers (location, lower(name)) where active;
alter table public.suppliers enable row level security;
revoke all on public.suppliers from anon, authenticated;

create or replace function public.mh_supplier_json(s public.suppliers)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object('id', s.id, 'name', s.name, 'contact', s.contact, 'phone', s.phone, 'email', s.email, 'note', s.note)
$function$;

-- The suppliers of the manager's location by name, and the names used in
-- Stock, Orders and Invoices that are not on the list yet.
create or replace function public.manager_supplier_list(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  return jsonb_build_object(
    'location', mgr.location,
    'suppliers', coalesce((
      select jsonb_agg(public.mh_supplier_json(s) order by lower(s.name))
        from public.suppliers s where s.location = mgr.location and s.active), '[]'::jsonb),
    'known', coalesce((
      select jsonb_agg(n order by lower(n)) from (
        select distinct on (lower(trim(x.n))) trim(x.n) n from (
          select i.supplier n from public.stock_items i where i.location = mgr.location and i.active
          union all select o.supplier from public.supplier_order_items o where o.location = mgr.location and o.active
          union all select v.supplier from public.supplier_invoices v where v.location = mgr.location and v.active
        ) x
        where length(trim(coalesce(x.n, ''))) between 1 and 60
          and not exists (select 1 from public.suppliers s where s.location = mgr.location and s.active and lower(s.name) = lower(trim(x.n)))
        order by lower(trim(x.n)), trim(x.n)
      ) k), '[]'::jsonb));
end $function$;

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

revoke all on function public.mh_supplier_json(public.suppliers) from public, anon, authenticated;
revoke all on function public.manager_supplier_list(uuid) from public, anon, authenticated;
revoke all on function public.manager_supplier_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_supplier_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mh_supplier_json(public.suppliers) to service_role;
grant execute on function public.manager_supplier_list(uuid) to service_role;
grant execute on function public.manager_supplier_save(uuid, jsonb) to service_role;
grant execute on function public.manager_supplier_remove(uuid, uuid) to service_role;
