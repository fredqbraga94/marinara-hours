-- Undo 20261117000000_price_blips.sql: both functions as they were
-- (price book from 20261116000000_product_links.sql, price changes from
-- 20261113000000_invoice_departments.sql).

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
    with raw as (
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
    -- Two names for one product (a manager said "Same as..."): one key.
    lines as (
      select r.invoice_id, r.supplier, r.invoice_date, r.created_at,
             coalesce(lk.same_as, r.product_key) as product_key, r.product_key as own_key,
             r.code, r.description, r.unit, r.unit_price, r.from_list
        from raw r
        left join public.supplier_product_links lk
          on lk.location = v_location and lower(lk.supplier) = lower(r.supplier) and lk.product_key = r.product_key
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
             'pack', coalesce(
                        (select pk.pack from public.supplier_product_packs pk
                          where pk.location = v_location and lower(pk.supplier) = lower(lt.supplier) and pk.product_key = lt.product_key),
                        (select max(((regexp_match(x.unit, '^\s*c(?:tn|arton)s?\s*\[(\d+)\]\s*$', 'i'))[1])::int)
                           from lines x where x.supplier = lt.supplier and x.product_key = lt.product_key)),
             -- Units in a carton typed by a manager (Products → tap a product).
             'pack_saved', exists (select 1 from public.supplier_product_packs pk
                          where pk.location = v_location and lower(pk.supplier) = lower(lt.supplier) and pk.product_key = lt.product_key),
             'times', (select count(*) from per_invoice x where x.supplier = lt.supplier and x.product_key = lt.product_key and not x.from_list),
             'last_from_list', lt.from_list,
             -- The other names joined to this product (Products → "Same as...").
             'merged', (select jsonb_agg(jsonb_build_object('product_key', m.own_key, 'code', m.code, 'description', m.description) order by m.description)
                          from (select distinct on (x.own_key) x.own_key, x.code, x.description
                                  from lines x where x.supplier = lt.supplier and x.product_key = lt.product_key and x.own_key <> lt.product_key
                                 order by x.own_key, x.invoice_date desc, x.created_at desc) m),
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
       where i.location = v_location and i.department = public.mh_invoice_dept() and i.active and i.kind = 'invoice'
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
