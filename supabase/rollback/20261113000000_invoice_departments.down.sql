-- Rollback of 20261113000000_invoice_departments.sql: one list of invoices
-- again (the department column is dropped; every invoice shows again).
drop function if exists public.manager_invoice_move(uuid, text, uuid, text);
drop function if exists public.manager_invoice_call(uuid, text, text, text, jsonb);

create or replace function public.mh_invoice_admin(p_manager_id uuid, p_location text)
returns text language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  if mgr.role not in ('manager', 'admin', 'kitchen_manager') then raise exception 'GM_REQUIRED'; end if;
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

create or replace function public.manager_invoice_usage(p_manager_id uuid, p_location text, p_weeks integer)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_weeks integer := least(greatest(coalesce(p_weeks, 8), 1), 26);
  v_today date := (now() at time zone 'Australia/Brisbane')::date;
  v_this_monday date := v_today - ((extract(isodow from v_today)::integer) - 1);
  v_from date := v_this_monday - (v_weeks - 1) * 7;
  v_first date;
  v_counted integer;
begin
  select min(invoice_date) into v_first from public.supplier_invoices
   where location = v_location and active and invoice_date between v_from and v_today;
  if v_first is not null and v_first < v_this_monday then
    v_this_monday := v_this_monday - 7;      -- last full week
    v_today := v_this_monday + 6;
    v_from := v_this_monday - (v_weeks - 1) * 7;
    select min(invoice_date) into v_first from public.supplier_invoices
     where location = v_location and active and invoice_date between v_from and v_today;
  end if;
  v_counted := case when v_first is null then 0
                    else ((v_this_monday - (v_first - ((extract(isodow from v_first)::integer) - 1))) / 7) + 1 end;
  return jsonb_build_object(
    'weeks', v_weeks, 'weeks_counted', v_counted, 'from', v_from, 'to', v_today,
    'week_starts', (select jsonb_agg(to_char(v_this_monday - (v_counted - 1 - g) * 7, 'YYYY-MM-DD') order by g)
                      from generate_series(0, greatest(v_counted - 1, 0)) g where v_counted > 0),
    'total_spend', coalesce((select sum(subtotal) from public.supplier_invoices
                              where location = v_location and active and invoice_date between v_from and v_today), 0),
    'items', coalesce((
      with l as (
        select i.supplier, coalesce(l.code, lower(l.description)) as k, l.code, l.description, l.unit,
               l.unit_price, l.line_total, i.invoice_date, i.created_at,
               case when i.kind = 'credit' then -abs(coalesce(l.qty, 0)) else coalesce(l.qty, 0) end as q,
               ((i.invoice_date - ((extract(isodow from i.invoice_date)::integer) - 1)) - (v_this_monday - (v_counted - 1) * 7)) / 7 as w
          from public.supplier_invoice_lines l
          join public.supplier_invoices i on i.id = l.invoice_id
         where i.location = v_location and i.active and i.invoice_date between v_from and v_today
           and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)'
      ), latest as (
        select distinct on (supplier, k) supplier, k, code, description, unit, unit_price
          from l where unit_price is not null and q > 0
         order by supplier, k, invoice_date desc, created_at desc
      ), per_week as (
        select supplier, k, w, sum(q) q from l group by supplier, k, w
      ), agg as (
        select supplier, k, sum(q) qty, sum(line_total) spend, count(distinct w) filter (where q > 0) weeks_bought
          from l group by supplier, k
      )
      select jsonb_agg(jsonb_build_object(
               'supplier', a.supplier, 'code', lt.code, 'description', lt.description, 'unit', lt.unit,
               'last_price', lt.unit_price, 'qty', round(a.qty, 2), 'spend', round(a.spend, 2),
               'weeks_bought', a.weeks_bought,
               'avg_per_week', round(a.qty / greatest(v_counted, 1), 2),
               'spend_per_week', round(a.spend / greatest(v_counted, 1), 2),
               'max_week', (select round(max(q), 2) from per_week pw where pw.supplier = a.supplier and pw.k = a.k),
               'by_week', (select jsonb_agg(coalesce((select round(pw.q, 2) from per_week pw
                                                       where pw.supplier = a.supplier and pw.k = a.k and pw.w = g), 0) order by g)
                             from generate_series(0, greatest(v_counted - 1, 0)) g))
             order by a.spend desc)
        from agg a join latest lt on lt.supplier = a.supplier and lt.k = a.k
       where a.qty > 0
    ), '[]'::jsonb));
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
             l.code, l.description, l.unit, l.unit_price
        from public.supplier_invoice_lines l
        join public.supplier_invoices i on i.id = l.invoice_id
       where i.location = v_location and i.active and i.kind = 'invoice'
         and l.unit_price is not null and l.unit_price > 0
         and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)|^delivery'
    ),
    -- One price per product per invoice (a product listed twice on the same
    -- invoice is averaged).
    per_invoice as (
      select supplier, product_key, invoice_id, invoice_date, max(created_at) as created_at,
             round(avg(unit_price), 4) as price
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
             'times', (select count(*) from per_invoice x where x.supplier = lt.supplier and x.product_key = lt.product_key),
             'last_price', lt.price, 'last_date', lt.invoice_date,
             'previous_price', pv.price, 'previous_date', pv.invoice_date,
             'change_pct', case when pv.price is null then null
                                else round((lt.price - pv.price) / pv.price * 100, 1) end,
             'history', (select jsonb_agg(jsonb_build_object('date', x.invoice_date, 'price', x.price)
                                          order by x.invoice_date, x.created_at)
                           from per_invoice x where x.supplier = lt.supplier and x.product_key = lt.product_key))
           order by lower(lb.description))
      from latest lt
      join label lb on lb.supplier = lt.supplier and lb.product_key = lt.product_key
      left join prev pv on pv.supplier = lt.supplier and pv.product_key = lt.product_key
  ), '[]'::jsonb));
end $function$;

create or replace function public.manager_invoice_top_products(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return (
    with imports as (
      select * from public.supplier_history_imports where location = v_location and active
    ),
    covered as (
      select lower(supplier) as supplier, unnest(invoice_numbers) as number from imports
    ),
    hist as (
      select h.supplier, p.code as product_key, p.code, p.brand, p.description, p.orders, p.spend, p.last_date,
             case when p.cartons > 0 and p.last_carton_price is not null then p.last_carton_price else p.last_unit_price end as last_price,
             case when p.cartons > 0 and p.last_carton_price is not null then 'carton' else 'unit' end as last_kind,
             case when p.cartons > 0 and p.last_carton_price is not null then p.carton_label else p.unit_label end as last_label,
             p.first_price, p.first_kind, p.first_date
        from public.supplier_history_products p
        join imports h on h.id = p.import_id
    ),
    lines as (
      select i.supplier, coalesce(l.code, lower(l.description)) as product_key, l.code, l.description,
             l.unit, l.unit_price, l.line_total, i.invoice_date, i.created_at, l.position, i.id as invoice_id,
             case when l.unit ~* '^\s*(ea|each|unit|btl|bottle|pk|pack|bag|tin|tub|block)\s*$' then 'unit' else 'carton' end as kind
        from public.supplier_invoice_lines l
        join public.supplier_invoices i on i.id = l.invoice_id
       where i.location = v_location and i.active and i.kind = 'invoice'
         and l.line_total > 0
         and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)|^delivery'
         and not exists (select 1 from covered c where c.supplier = lower(i.supplier) and c.number = i.number)
    ),
    scan as (
      select supplier, product_key,
             count(distinct invoice_id) as orders, sum(line_total) as spend, max(invoice_date) as last_date,
             (array_agg(code order by invoice_date desc, created_at desc, position))[1] as code,
             (array_agg(description order by invoice_date desc, created_at desc, position))[1] as description,
             (array_agg(unit_price order by invoice_date desc, created_at desc, position))[1] as last_price,
             (array_agg(kind order by invoice_date desc, created_at desc, position))[1] as last_kind,
             (array_agg(unit order by invoice_date desc, created_at desc, position))[1] as last_label,
             (array_agg(unit_price order by invoice_date, created_at, position))[1] as first_price,
             (array_agg(kind order by invoice_date, created_at, position))[1] as first_kind,
             min(invoice_date) as first_date
        from lines
       group by supplier, product_key
    ),
    merged as (
      select coalesce(s.supplier, h.supplier) as supplier,
             coalesce(s.product_key, h.product_key) as product_key,
             coalesce(s.code, h.code) as code,
             h.brand,
             coalesce(h.description, s.description) as description,
             coalesce(h.orders, 0) + coalesce(s.orders, 0) as orders,
             coalesce(h.spend, 0) + coalesce(s.spend, 0) as spend,
             greatest(h.last_date, s.last_date) as last_date,
             case when s.last_date is not null and (h.last_date is null or s.last_date >= h.last_date) then s.last_price else h.last_price end as last_price,
             case when s.last_date is not null and (h.last_date is null or s.last_date >= h.last_date) then s.last_kind else h.last_kind end as last_kind,
             case when s.last_date is not null and (h.last_date is null or s.last_date >= h.last_date) then s.last_label else h.last_label end as last_label,
             case when h.first_date is not null and (s.first_date is null or h.first_date <= s.first_date) then h.first_price else s.first_price end as first_price,
             case when h.first_date is not null and (s.first_date is null or h.first_date <= s.first_date) then h.first_kind else s.first_kind end as first_kind,
             least(h.first_date, s.first_date) as first_date,
             h.code is not null as from_history
        from scan s
        full join hist h on lower(h.supplier) = lower(s.supplier) and h.product_key = s.product_key
    )
    select jsonb_build_object(
      'period_from', (select least((select min(period_from) from imports), (select min(invoice_date) from lines))),
      'total', coalesce((select sum(spend) from merged), 0),
      'imports', coalesce((select jsonb_agg(jsonb_build_object('supplier', supplier, 'from', period_from, 'to', period_to, 'source', source) order by supplier) from imports), '[]'::jsonb),
      'products', coalesce((select jsonb_agg(jsonb_build_object(
          'supplier', supplier, 'code', code, 'brand', brand, 'description', description,
          'orders', orders, 'spend', round(spend, 2), 'last_date', last_date,
          'last_price', last_price, 'last_label', last_label,
          'first_price', first_price, 'first_date', first_date,
          'change_pct', case when first_price > 0 and last_price is not null and first_kind = last_kind and first_date < last_date
                             then round((last_price - first_price) / first_price * 100, 1) end,
          'from_history', from_history)
        order by spend desc, lower(description)) from merged), '[]'::jsonb)));
end $function$;

create or replace function public.mh_invoice_products(p_location text)
returns table (supplier text, product_key text, code text, description text, unit text,
               unit_price numeric, invoice_date date)
language sql stable security definer set search_path to 'public'
as $function$
  select distinct on (i.supplier, coalesce(l.code, lower(l.description)))
         i.supplier, coalesce(l.code, lower(l.description)), l.code, l.description, l.unit,
         l.unit_price, i.invoice_date
    from public.supplier_invoice_lines l
    join public.supplier_invoices i on i.id = l.invoice_id
   where i.location = p_location and i.active and i.kind = 'invoice'
     and l.unit_price is not null and l.unit_price > 0
     and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)|^delivery'
   order by i.supplier, coalesce(l.code, lower(l.description)), i.invoice_date desc, i.created_at desc
$function$;

drop function if exists public.mh_invoice_dept();
drop index if exists public.supplier_invoices_dept_idx;
alter table public.supplier_invoices drop column if exists department;
