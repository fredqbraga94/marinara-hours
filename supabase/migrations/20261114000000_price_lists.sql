-- Supplier price lists (e.g. the list Gulli sends with the current price of each
-- product): imported from the file in Finance → Products. A price list is not a
-- purchase: its prices show in Products (marked "price list") and are used for
-- dish costs, but they do not count as spending, weekly use or orders. Like
-- invoices, each list belongs to Kitchen or Floor (drinks go to Floor).
-- Importing the same supplier on the same date again replaces that list.
-- Changes: two new tables, two new functions, and three functions redefined
-- to read the lists too (price book, products for dish costs, invoice call).

create table if not exists public.supplier_price_lists (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  department text not null default 'Kitchen' check (department in ('Kitchen', 'Floor')),
  supplier text not null check (length(trim(supplier)) between 1 and 80),
  list_date date not null,
  file_name text check (file_name is null or length(file_name) <= 200),
  item_count integer not null default 0,
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  removed_by uuid references public.staff(id),
  removed_at timestamptz
);
create unique index if not exists supplier_price_lists_one_a_day_idx
  on public.supplier_price_lists (location, department, lower(supplier), list_date) where active;
alter table public.supplier_price_lists enable row level security;
revoke all on public.supplier_price_lists from anon, authenticated;

create table if not exists public.supplier_price_list_items (
  list_id uuid not null references public.supplier_price_lists(id) on delete cascade,
  position integer not null,
  code text check (code is null or length(code) <= 40),
  description text not null check (length(trim(description)) between 1 and 300),
  unit text check (unit is null or length(unit) <= 40),
  unit_price numeric(12, 4) not null check (unit_price > 0 and unit_price < 1000000),
  pack integer check (pack is null or pack between 1 and 10000),
  primary key (list_id, position)
);
alter table public.supplier_price_list_items enable row level security;
revoke all on public.supplier_price_list_items from anon, authenticated;

-- Save one price list on the list of this call (set by manager_invoice_call).
-- p_list: {supplier, date, file_name?, items: [{code?, description, unit?, unit_price, pack?}]}.
create or replace function public.mh_price_list_save(p_manager_id uuid, p_location text, p_list jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_dep text := public.mh_invoice_dept();
  v_supplier text := trim(coalesce(p_list->>'supplier', ''));
  v_row public.supplier_price_lists%rowtype;
  v_item jsonb;
  v_pos integer := 0;
  v_replaced integer;
begin
  if v_supplier = '' or jsonb_typeof(p_list->'items') <> 'array'
     or jsonb_array_length(p_list->'items') = 0 or jsonb_array_length(p_list->'items') > 1000 then
    raise exception 'INVALID_INPUT';
  end if;
  update public.supplier_price_lists set active = false, removed_by = p_manager_id, removed_at = now()
   where location = v_location and department = v_dep and active
     and lower(supplier) = lower(v_supplier) and list_date = (p_list->>'date')::date;
  get diagnostics v_replaced = row_count;
  insert into public.supplier_price_lists (location, department, supplier, list_date, file_name, item_count, created_by)
  values (v_location, v_dep, v_supplier, (p_list->>'date')::date, nullif(left(p_list->>'file_name', 200), ''),
          jsonb_array_length(p_list->'items'), p_manager_id)
  returning * into v_row;
  for v_item in select * from jsonb_array_elements(p_list->'items') loop
    insert into public.supplier_price_list_items (list_id, position, code, description, unit, unit_price, pack)
    values (v_row.id, v_pos, nullif(left(trim(coalesce(v_item->>'code', '')), 40), ''),
            left(trim(coalesce(v_item->>'description', '')), 300),
            nullif(left(trim(coalesce(v_item->>'unit', '')), 40), ''),
            (v_item->>'unit_price')::numeric, nullif(v_item->>'pack', '')::integer);
    v_pos := v_pos + 1;
  end loop;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (null, p_manager_id, p_manager_id, 'manager_price_list_save', null,
          jsonb_build_object('list', v_row.id, 'supplier', v_row.supplier, 'date', v_row.list_date,
                             'items', v_row.item_count, 'department', v_dep, 'replaced', v_replaced));
  return jsonb_build_object('id', v_row.id, 'supplier', v_row.supplier, 'date', v_row.list_date,
                            'items', v_row.item_count, 'department', v_dep, 'replaced', v_replaced > 0);
exception
  when check_violation or invalid_text_representation or not_null_violation or datetime_field_overflow
       or invalid_datetime_format or numeric_value_out_of_range then raise exception 'INVALID_INPUT';
end $function$;

-- The price lists of this call's list, newest first.
create or replace function public.mh_price_lists(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return jsonb_build_object('lists', coalesce((
    select jsonb_agg(jsonb_build_object('id', pl.id, 'supplier', pl.supplier, 'date', pl.list_date,
                                        'items', pl.item_count, 'file_name', pl.file_name)
                     order by pl.list_date desc, pl.created_at desc)
      from public.supplier_price_lists pl
     where pl.location = v_location and pl.department = public.mh_invoice_dept() and pl.active), '[]'::jsonb));
end $function$;

create or replace function public.manager_invoice_price_book(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return jsonb_build_object('products', coalesce((
    with lines as (
      select i.id as invoice_id, i.supplier, i.invoice_date, i.created_at,
             coalesce(l.code, lower(l.description)) as product_key,
             l.code, l.description, l.unit, l.unit_price, false as from_list
        from public.supplier_invoice_lines l
        join public.supplier_invoices i on i.id = l.invoice_id
       where i.location = v_location and i.department = public.mh_invoice_dept() and i.active and i.kind = 'invoice'
         and l.unit_price is not null and l.unit_price > 0
         and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)|^delivery'
      union all
      -- The supplier's price lists: a price on that date, not a purchase.
      select pl.id, pl.supplier, pl.list_date, pl.created_at,
             coalesce(it.code, lower(it.description)), it.code, it.description, it.unit, it.unit_price, true
        from public.supplier_price_list_items it
        join public.supplier_price_lists pl on pl.id = it.list_id
       where pl.location = v_location and pl.department = public.mh_invoice_dept() and pl.active
    ),
    -- One price per product per invoice (a product listed twice on the same
    -- invoice is averaged).
    per_invoice as (
      select supplier, product_key, invoice_id, invoice_date, max(created_at) as created_at,
             round(avg(unit_price), 4) as price, bool_or(from_list) as from_list
        from lines
       group by supplier, product_key, invoice_id, invoice_date
    ),
    ranked as (
      select p.*, row_number() over (partition by supplier, product_key order by invoice_date desc, created_at desc) as rn
        from per_invoice p
    ),
    latest as (select * from ranked where rn = 1),
    prev as (
      select distinct on (r.supplier, r.product_key) r.supplier, r.product_key, r.price, r.invoice_date
        from ranked r
        join latest lt on lt.supplier = r.supplier and lt.product_key = r.product_key
       where r.rn > 1 and r.price <> lt.price
       order by r.supplier, r.product_key, r.invoice_date desc, r.created_at desc
    ),
    label as (
      select distinct on (supplier, product_key) supplier, product_key, code, description, unit
        from lines
       order by supplier, product_key, invoice_date desc, created_at desc
    )
    select jsonb_agg(jsonb_build_object(
             'supplier', lt.supplier, 'product_key', lt.product_key,
             'code', lb.code, 'description', lb.description, 'unit', lb.unit,
             -- Units to a carton when the supplier counts single units ("Ctn [4]").
             'pack', (select max(((regexp_match(x.unit, '^\s*c(?:tn|arton)s?\s*\[(\d+)\]\s*$', 'i'))[1])::int)
                        from lines x where x.supplier = lt.supplier and x.product_key = lt.product_key),
             'times', (select count(*) from per_invoice x where x.supplier = lt.supplier and x.product_key = lt.product_key and not x.from_list),
             'last_from_list', lt.from_list,
             'last_price', lt.price, 'last_date', lt.invoice_date,
             'previous_price', pv.price, 'previous_date', pv.invoice_date,
             'change_pct', case when pv.price is null then null
                                else round((lt.price - pv.price) / pv.price * 100, 1) end,
             'history', (select jsonb_agg(jsonb_build_object('date', x.invoice_date, 'price', x.price, 'list', x.from_list)
                                          order by x.invoice_date, x.created_at)
                           from per_invoice x where x.supplier = lt.supplier and x.product_key = lt.product_key))
           order by lower(lb.description))
      from latest lt
      join label lb on lb.supplier = lt.supplier and lb.product_key = lt.product_key
      left join prev pv on pv.supplier = lt.supplier and pv.product_key = lt.product_key
  ), '[]'::jsonb));
end $function$;

-- Products to link to ingredients and dishes: Kitchen invoices and Kitchen price lists.
create or replace function public.mh_invoice_products(p_location text)
returns table (supplier text, product_key text, code text, description text, unit text,
               unit_price numeric, invoice_date date)
language sql stable security definer set search_path to 'public'
as $function$
  select distinct on (x.supplier, x.product_key)
         x.supplier, x.product_key, x.code, x.description, x.unit, x.unit_price, x.invoice_date
    from (
  select i.supplier, coalesce(l.code, lower(l.description)) as product_key, l.code, l.description, l.unit,
         l.unit_price, i.invoice_date, i.created_at
    from public.supplier_invoice_lines l
    join public.supplier_invoices i on i.id = l.invoice_id
   where i.location = p_location and i.department = 'Kitchen' and i.active and i.kind = 'invoice'
     and l.unit_price is not null and l.unit_price > 0
     and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)|^delivery'
  union all
  select pl.supplier, coalesce(it.code, lower(it.description)), it.code, it.description, it.unit,
         it.unit_price, pl.list_date, pl.created_at
    from public.supplier_price_list_items it
    join public.supplier_price_lists pl on pl.id = it.list_id
   where pl.location = p_location and pl.department = 'Kitchen' and pl.active
    ) x
   order by x.supplier, x.product_key, x.invoice_date desc, x.created_at desc
$function$;

-- One invoice call on one list (as before), plus price_list_save {list} and price_lists.
create or replace function public.manager_invoice_call(p_manager_id uuid, p_location text, p_department text, p_action text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_dep text := public.mh_stock_department(mgr.role, coalesce(nullif(p_department, ''), public.mh_scope(mgr.role), 'Kitchen'));
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
begin
  perform set_config('mh.invoice_department', v_dep, true);
  return case p_action
    when 'save' then public.manager_invoice_save(p_manager_id, p_location, v_args->'invoice')
    when 'list' then public.manager_invoice_list(p_manager_id, p_location, (v_args->>'from')::date, (v_args->>'to')::date)
                     || jsonb_build_object('department', v_dep, 'can_choose_department', public.mh_scope(mgr.role) is null)
    when 'get' then public.manager_invoice_get(p_manager_id, p_location, (v_args->>'id')::uuid)
    when 'remove' then public.manager_invoice_remove(p_manager_id, p_location, (v_args->>'id')::uuid)
    when 'price_changes' then public.manager_invoice_price_changes(p_manager_id, p_location)
    when 'price_book' then public.manager_invoice_price_book(p_manager_id, p_location)
                     || jsonb_build_object('department', v_dep)
    when 'top_products' then public.manager_invoice_top_products(p_manager_id, p_location)
                     || jsonb_build_object('department', v_dep)
    when 'usage' then public.manager_invoice_usage(p_manager_id, p_location, (v_args->>'weeks')::integer)
                     || jsonb_build_object('department', v_dep)
    when 'price_list_save' then public.mh_price_list_save(p_manager_id, p_location, v_args->'list')
    when 'price_lists' then public.mh_price_lists(p_manager_id, p_location) || jsonb_build_object('department', v_dep)
    else null end;
end $function$;

revoke all on function public.mh_price_list_save(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.mh_price_lists(uuid, text) from public, anon, authenticated;
grant execute on function public.mh_price_list_save(uuid, text, jsonb) to service_role;
grant execute on function public.mh_price_lists(uuid, text) to service_role;
