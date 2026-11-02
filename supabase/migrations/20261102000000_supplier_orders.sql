-- Orders to a supplier (first: Niko): the list of what is usually
-- ordered from them, a quantity next to each item, and a PDF to forward instead
-- of sending a message item by item. No stock count, no par level.
-- Each order is saved (who, when, lines), so the last one can be repeated.
-- Any manager; one list per location (the Administrator's viewed unit).
-- Additive only: two new tables and three new functions. Nothing existing changes.

create table if not exists public.supplier_order_items (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  supplier text not null check (length(trim(supplier)) between 1 and 60),
  name text not null check (length(trim(name)) between 1 and 80),
  unit text check (unit is null or length(unit) <= 20),
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now()
);
create index if not exists supplier_order_items_idx on public.supplier_order_items (location, supplier) where active;

create table if not exists public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  supplier text not null,
  deliver_on date,
  note text check (note is null or length(note) <= 300),
  lines jsonb not null,
  created_by uuid not null references public.staff(id),
  created_at timestamptz not null default now()
);
create index if not exists supplier_orders_idx on public.supplier_orders (location, supplier, created_at desc);

alter table public.supplier_order_items enable row level security;
alter table public.supplier_orders enable row level security;
revoke all on public.supplier_order_items, public.supplier_orders from anon, authenticated;

-- The suppliers with a list, the items of p_supplier and its last 5 orders.
create or replace function public.manager_order_list(p_manager_id uuid, p_supplier text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_sup text := nullif(trim(coalesce(p_supplier, '')), '');
begin
  if v_sup is null then
    select i.supplier into v_sup from public.supplier_order_items i
     where i.location = mgr.location and i.active order by i.created_at limit 1;
  end if;
  return jsonb_build_object(
    'location', mgr.location, 'supplier', v_sup,
    'suppliers', coalesce((select jsonb_agg(s order by lower(s)) from (select distinct i.supplier s from public.supplier_order_items i
                            where i.location = mgr.location and i.active) x), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'unit', i.unit) order by lower(i.name))
                         from public.supplier_order_items i where i.location = mgr.location and i.active and i.supplier = v_sup), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'deliver_on', o.deliver_on, 'note', o.note, 'lines', o.lines,
                          'created_at', o.created_at, 'by', (select s.name from public.staff s where s.id = o.created_by)) order by o.created_at desc)
                          from (select * from public.supplier_orders o where o.location = mgr.location and o.supplier = v_sup
                                 order by o.created_at desc limit 5) o), '[]'::jsonb));
end $function$;

-- Add an item (p_item: {supplier, name, unit?}), or take one off (p_item: {id, active: false}).
create or replace function public.manager_order_item_save(p_manager_id uuid, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_row public.supplier_order_items%rowtype;
  v_sup text := nullif(left(trim(coalesce(p_item->>'supplier', '')), 60), '');
  v_name text := nullif(left(trim(coalesce(p_item->>'name', '')), 80), '');
  v_unit text := nullif(left(trim(coalesce(p_item->>'unit', '')), 20), '');
begin
  if p_item ? 'id' and p_item->>'id' is not null then
    update public.supplier_order_items
       set active = coalesce((p_item->>'active')::boolean, active),
           name = coalesce(v_name, name),
           unit = case when p_item ? 'unit' then v_unit else unit end
     where id = (p_item->>'id')::uuid and location = mgr.location
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    if v_sup is null or v_name is null then raise exception 'INVALID_INPUT'; end if;
    select * into v_row from public.supplier_order_items
     where location = mgr.location and active and lower(supplier) = lower(v_sup) and lower(name) = lower(v_name);
    if found then return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'unit', v_row.unit, 'supplier', v_row.supplier, 'existing', true); end if;
    insert into public.supplier_order_items (location, supplier, name, unit, created_by)
    values (mgr.location, v_sup, v_name, v_unit, p_manager_id)
    returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'unit', v_row.unit, 'supplier', v_row.supplier, 'active', v_row.active);
end $function$;

-- Save an order. p_order: {supplier, deliver_on?, note?, lines: [{name, unit?, qty}]}.
create or replace function public.manager_order_save(p_manager_id uuid, p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_sup text := nullif(left(trim(coalesce(p_order->>'supplier', '')), 60), '');
  v_note text := nullif(left(trim(coalesce(p_order->>'note', '')), 300), '');
  v_day date;
  v_lines jsonb;
  v_row public.supplier_orders%rowtype;
begin
  begin v_day := nullif(p_order->>'deliver_on', '')::date; exception when others then raise exception 'INVALID_INPUT'; end;
  if v_sup is null or jsonb_typeof(p_order->'lines') <> 'array' then raise exception 'INVALID_INPUT'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', left(trim(l->>'name'), 80), 'unit', nullif(left(trim(coalesce(l->>'unit', '')), 20), ''),
                                               'qty', left(trim(l->>'qty'), 12))), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(p_order->'lines') l
   where nullif(trim(coalesce(l->>'name', '')), '') is not null and nullif(trim(coalesce(l->>'qty', '')), '') is not null;
  if jsonb_array_length(v_lines) = 0 or jsonb_array_length(v_lines) > 200 then raise exception 'INVALID_INPUT'; end if;
  insert into public.supplier_orders (location, supplier, deliver_on, note, lines, created_by)
  values (mgr.location, v_sup, v_day, v_note, v_lines, p_manager_id)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'created_at', v_row.created_at, 'lines', v_row.lines);
end $function$;

revoke all on function public.manager_order_list(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_order_item_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_order_save(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.manager_order_list(uuid, text) to service_role;
grant execute on function public.manager_order_item_save(uuid, jsonb) to service_role;
grant execute on function public.manager_order_save(uuid, jsonb) to service_role;
