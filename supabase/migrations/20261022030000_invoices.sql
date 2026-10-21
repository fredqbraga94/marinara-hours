-- Supplier invoices: the app reads the PDF on the phone/laptop (no AI, no
-- outside service) and saves the invoice and its lines here. Administrator
-- only. Used for spend per supplier and for price changes per product.
-- Additive only: new tables and new functions. Nothing existing changes.

create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  supplier text not null check (length(trim(supplier)) between 1 and 80),
  kind text not null default 'invoice' check (kind in ('invoice', 'credit')),
  number text not null check (length(trim(number)) between 1 and 60),
  invoice_date date not null,
  subtotal numeric(12,2) not null,
  gst numeric(12,2) not null default 0,
  total numeric(12,2) not null,
  checks_ok boolean not null default false,
  file_name text check (file_name is null or length(file_name) <= 200),
  active boolean not null default true,
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  removed_by uuid references public.staff(id),
  removed_at timestamptz
);
create unique index if not exists supplier_invoices_unique_idx
  on public.supplier_invoices (location, supplier, kind, number) where active;
create index if not exists supplier_invoices_date_idx on public.supplier_invoices (location, invoice_date) where active;

create table if not exists public.supplier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.supplier_invoices(id),
  position integer not null default 0,
  code text check (code is null or length(code) <= 40),
  description text not null check (length(description) <= 300),
  qty numeric(12,3),
  unit text check (unit is null or length(unit) <= 40),
  unit_price numeric(12,4),
  line_total numeric(12,2) not null,
  gst numeric(12,2) not null default 0
);
create index if not exists supplier_invoice_lines_invoice_idx on public.supplier_invoice_lines (invoice_id, position);
create index if not exists supplier_invoice_lines_code_idx on public.supplier_invoice_lines (code);

alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_lines enable row level security;
revoke all on public.supplier_invoices, public.supplier_invoice_lines from anon, authenticated;

create or replace function public.mh_invoice_admin(p_manager_id uuid, p_location text)
returns text language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  if mgr.role not in ('manager', 'admin') then raise exception 'GM_REQUIRED'; end if;
  return case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
end $function$;

create or replace function public.mh_invoice_json(i public.supplier_invoices)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'supplier', i.supplier, 'kind', i.kind, 'number', i.number,
    'invoice_date', i.invoice_date, 'subtotal', i.subtotal, 'gst', i.gst, 'total', i.total,
    'checks_ok', i.checks_ok, 'file_name', i.file_name, 'created_at', i.created_at,
    'line_count', (select count(*) from public.supplier_invoice_lines l where l.invoice_id = i.id))
$function$;

-- Save one invoice read from a PDF. p_invoice: {supplier, kind, number, date,
-- subtotal, gst, total, checks_ok, file_name, lines:[{code, description, qty,
-- unit, unit_price, line_total, gst}]}. The same invoice twice is refused.
create or replace function public.manager_invoice_save(p_manager_id uuid, p_location text, p_invoice jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_row public.supplier_invoices%rowtype;
  v_line jsonb;
  v_pos integer := 0;
begin
  if jsonb_typeof(p_invoice->'lines') <> 'array' or jsonb_array_length(p_invoice->'lines') > 300 then
    raise exception 'INVALID_INPUT';
  end if;
  if exists (select 1 from public.supplier_invoices
              where location = v_location and active and supplier = trim(p_invoice->>'supplier')
                and kind = coalesce(p_invoice->>'kind', 'invoice') and number = trim(p_invoice->>'number')) then
    raise exception 'INVOICE_DUPLICATE';
  end if;
  insert into public.supplier_invoices (location, supplier, kind, number, invoice_date, subtotal, gst, total,
                                        checks_ok, file_name, created_by)
  values (v_location, trim(p_invoice->>'supplier'), coalesce(p_invoice->>'kind', 'invoice'),
          trim(p_invoice->>'number'), (p_invoice->>'date')::date,
          (p_invoice->>'subtotal')::numeric, coalesce((p_invoice->>'gst')::numeric, 0), (p_invoice->>'total')::numeric,
          coalesce((p_invoice->>'checks_ok')::boolean, false), nullif(left(p_invoice->>'file_name', 200), ''),
          p_manager_id)
  returning * into v_row;
  for v_line in select * from jsonb_array_elements(p_invoice->'lines') loop
    insert into public.supplier_invoice_lines (invoice_id, position, code, description, qty, unit, unit_price, line_total, gst)
    values (v_row.id, v_pos, nullif(left(trim(coalesce(v_line->>'code', '')), 40), ''),
            left(trim(coalesce(v_line->>'description', '')), 300),
            (v_line->>'qty')::numeric, nullif(left(trim(coalesce(v_line->>'unit', '')), 40), ''),
            (v_line->>'unit_price')::numeric, (v_line->>'line_total')::numeric,
            coalesce((v_line->>'gst')::numeric, 0));
    v_pos := v_pos + 1;
  end loop;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (null, p_manager_id, p_manager_id, 'manager_invoice_save', null,
          jsonb_build_object('invoice', v_row.id, 'supplier', v_row.supplier, 'number', v_row.number, 'total', v_row.total));
  return public.mh_invoice_json(v_row);
exception
  when check_violation or invalid_text_representation or not_null_violation or datetime_field_overflow
       or invalid_datetime_format or numeric_value_out_of_range then raise exception 'INVALID_INPUT';
  when unique_violation then raise exception 'INVOICE_DUPLICATE';
end $function$;

-- Invoices between two dates (by invoice date) with totals per supplier.
create or replace function public.manager_invoice_list(p_manager_id uuid, p_location text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return jsonb_build_object(
    'location', v_location, 'from', p_from, 'to', p_to,
    'invoices', coalesce((
      select jsonb_agg(public.mh_invoice_json(i) order by i.invoice_date desc, i.supplier, i.number)
        from public.supplier_invoices i
       where i.location = v_location and i.active and i.invoice_date between p_from and p_to), '[]'::jsonb),
    'by_supplier', coalesce((
      select jsonb_agg(jsonb_build_object('supplier', supplier, 'count', n, 'total', t) order by t desc)
        from (select supplier, count(*) n, sum(total) t from public.supplier_invoices
               where location = v_location and active and invoice_date between p_from and p_to
               group by supplier) s), '[]'::jsonb),
    'total', coalesce((select sum(total) from public.supplier_invoices
                        where location = v_location and active and invoice_date between p_from and p_to), 0));
end $function$;

create or replace function public.manager_invoice_get(p_manager_id uuid, p_location text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_row public.supplier_invoices%rowtype;
begin
  select * into v_row from public.supplier_invoices where id = p_id and location = v_location and active;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  return public.mh_invoice_json(v_row) || jsonb_build_object('lines', coalesce((
    select jsonb_agg(jsonb_build_object('code', l.code, 'description', l.description, 'qty', l.qty, 'unit', l.unit,
                                        'unit_price', l.unit_price, 'line_total', l.line_total, 'gst', l.gst)
                     order by l.position)
      from public.supplier_invoice_lines l where l.invoice_id = v_row.id), '[]'::jsonb));
end $function$;

-- Remove an invoice saved by mistake (kept, switched off, can be saved again).
create or replace function public.manager_invoice_remove(p_manager_id uuid, p_location text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_row public.supplier_invoices%rowtype;
begin
  update public.supplier_invoices set active = false, removed_by = p_manager_id, removed_at = now()
   where id = p_id and location = v_location and active returning * into v_row;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (null, p_manager_id, p_manager_id, 'manager_invoice_remove',
          jsonb_build_object('invoice', v_row.id, 'supplier', v_row.supplier, 'number', v_row.number, 'total', v_row.total), null);
  return jsonb_build_object('id', p_id, 'active', false);
end $function$;

-- Products whose price changed: the latest price against the one before it
-- (same supplier and product code, invoices only), biggest change first.
create or replace function public.manager_invoice_price_changes(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return coalesce((
    with p as (
      select i.supplier, l.code, l.description, l.unit, l.unit_price, i.invoice_date,
             row_number() over (partition by i.supplier, l.code order by i.invoice_date desc, i.created_at desc) rn
        from public.supplier_invoice_lines l
        join public.supplier_invoices i on i.id = l.invoice_id
       where i.location = v_location and i.active and i.kind = 'invoice'
         and l.code is not null and l.unit_price is not null and l.unit_price > 0
    ), latest as (select * from p where rn = 1),
    prev as (
      select distinct on (p.supplier, p.code) p.supplier, p.code, p.unit_price, p.invoice_date
        from p join latest lt on lt.supplier = p.supplier and lt.code = p.code
       where p.rn > 1 and p.unit_price <> lt.unit_price
       order by p.supplier, p.code, p.invoice_date desc
    )
    select jsonb_agg(jsonb_build_object(
             'supplier', lt.supplier, 'code', lt.code, 'description', lt.description, 'unit', lt.unit,
             'previous_price', pv.unit_price, 'previous_date', pv.invoice_date,
             'latest_price', lt.unit_price, 'latest_date', lt.invoice_date,
             'change_pct', round((lt.unit_price - pv.unit_price) / pv.unit_price * 100, 1))
           order by abs(lt.unit_price - pv.unit_price) / pv.unit_price desc)
      from latest lt join prev pv on pv.supplier = lt.supplier and pv.code = lt.code
  ), '[]'::jsonb);
end $function$;

revoke all on function public.mh_invoice_admin(uuid, text) from public, anon, authenticated;
revoke all on function public.mh_invoice_json(public.supplier_invoices) from public, anon, authenticated;
revoke all on function public.manager_invoice_save(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.manager_invoice_list(uuid, text, date, date) from public, anon, authenticated;
revoke all on function public.manager_invoice_get(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.manager_invoice_remove(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.manager_invoice_price_changes(uuid, text) from public, anon, authenticated;
grant execute on function public.manager_invoice_save(uuid, text, jsonb) to service_role;
grant execute on function public.manager_invoice_list(uuid, text, date, date) to service_role;
grant execute on function public.manager_invoice_get(uuid, text, uuid) to service_role;
grant execute on function public.manager_invoice_remove(uuid, text, uuid) to service_role;
grant execute on function public.manager_invoice_price_changes(uuid, text) to service_role;
