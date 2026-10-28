-- Most bought products: a ranking of what the restaurant buys most, by spend
-- and by number of orders, with the last price paid and the change over the
-- period. It joins two sources:
--  1. Supplier history imported once (e.g. 12 months of a supplier's online
--     account), one row per product with totals for the period.
--  2. The invoices saved in the app (scanned PDFs), line by line.
-- An invoice that is part of an imported history is never counted twice: the
-- import lists the invoice numbers it covers, and those saved invoices are
-- left out of the second source.
-- Administrator and Kitchen Manager only (mh_invoice_admin), like the price book.
-- Additive only: two new tables and one new read-only function. The history
-- rows themselves are loaded separately (they hold real prices and are never
-- kept in this public repository).

create table if not exists public.supplier_history_imports (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  supplier text not null check (length(trim(supplier)) between 1 and 80),
  period_from date not null,
  period_to date not null check (period_to >= period_from),
  source text not null check (length(source) <= 200),
  invoice_numbers text[] not null default '{}',
  imported_at timestamptz not null default now(),
  active boolean not null default true
);
create index if not exists supplier_history_imports_location_idx on public.supplier_history_imports (location) where active;

create table if not exists public.supplier_history_products (
  import_id uuid not null references public.supplier_history_imports(id) on delete cascade,
  code text not null check (length(code) between 1 and 40),
  brand text check (brand is null or length(brand) <= 80),
  description text not null check (length(description) between 1 and 300),
  orders integer not null check (orders >= 0),
  cartons numeric(12,3) not null default 0,
  units numeric(12,3) not null default 0,
  carton_label text check (carton_label is null or length(carton_label) <= 40),
  unit_label text check (unit_label is null or length(unit_label) <= 40),
  spend numeric(12,2) not null,
  last_date date,
  last_carton_price numeric(12,4),
  last_unit_price numeric(12,4),
  first_price numeric(12,4),
  first_kind text check (first_kind is null or first_kind in ('carton', 'unit')),
  first_date date,
  primary key (import_id, code)
);

alter table public.supplier_history_imports enable row level security;
alter table public.supplier_history_products enable row level security;
revoke all on public.supplier_history_imports, public.supplier_history_products from anon, authenticated;

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

revoke all on function public.manager_invoice_top_products(uuid, text) from public, anon, authenticated;
grant execute on function public.manager_invoice_top_products(uuid, text) to service_role;
